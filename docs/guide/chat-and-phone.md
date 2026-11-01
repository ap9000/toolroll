# Chat and your phone

## The lead

**Chat** is a conversation with the lead: an assistant that reads your
projects, drafts tasks and flows, and proposes actions as cards you confirm.
It never changes anything without your confirmation, and never asks for a
password or key: those go on secure screens.

`/chat` in the console, `toolroll chat` in the terminal, and Telegram, Slack,
Discord and Teams all talk to the same lead with the same tools. The lead
reads the fleet and **only proposes**: file a task (or a scout), move one to
the front, reserve it for a worker, hold it, rewrite a scope,
retry/replace/unlink a terminal dependency, send a task's agent guidance,
cancel, or suggest an answer to a parked decision. Every proposal is a card
you confirm, with every consequence and the builder's recommendation shown
beside the lead's pick; a scope the lead wrote never seals under an operating
mode. Absolute paths, internal digests and account names are redacted; source
context includes relative file citations. Direct API use spends against a
ceiling you set per conversation. The console keeps a live pulse for every
admitted project beside that shared thread, with one-click fleet questions
and a direct road to each project's board.

The lead has **subagents**: named helpers, each with its own personality,
instructions and rules (what it does on its own, what it asks first, what it
never does). Say "ask Maya to draft the refund reply" and the lead shows a
card with exactly what goes to Maya; once you confirm, Maya works it within
its rules and its answer comes back to you. A flow step can call a subagent by
name too. They live in **Settings → Lead → Subagents** ([guide](subagents.md)).
Subagents used to be called AI teammates; each carried over unchanged.

**Describe new work once.** The lead infers a concise title, narrow scope,
safe non-goals, and proof criteria; it asks only when the project or outcome
is genuinely ambiguous, or when an irreversible or compatibility tradeoff
changes what should be built. Questions are grouped, carry a recommended
default, and stop for reversible choices when you say **use your judgment**.
The task card says whether Toolroll will inspect the repository and draft a
plan before asking you to approve anything.

**Ask about one task.** Every task has an **Overview / Ask** switch. **Ask**
opens a focused companion to that task without creating another
conversation: Toolroll attaches the current task to each new message, keeps
the live status beside the thread, and offers plain-language starters for
status, scope revision, steering, and result inspection. Proposed guidance is
inert until you confirm its card. A running build's agent then reads it when
it next checks for notes; otherwise the next attempt does. Each note says
whether the agent has read it.

**Results.** When a task finishes, both views lead with the same Ready status
and result. Open the work and its actual checks, then mark Complete or
request changes. Historical diagnostics remain available in details; optional
missing assessments do not create another review stage. Chat cannot rewrite
the stored result. The evidence page opens the sealed patch in a clean
**View** mode. Switch to **Annotate** only when you need a change: select the
exact line, leave plain-language feedback, and collect as many notes as
needed. Creating a revision is a separate, optional act that seals the exact
annotation batch into one scoped task for approval.

**Which model the chat uses.** The chat setup screen defaults to **Codex
membership · default model**. Run `codex login` once on the machine serving
Toolroll, choose that provider, and there is no Toolroll dollar maximum. The
conversation stays live until you end it; the daily turn limit and your
plan's own upstream limits still apply. Anthropic membership works the same
way after signing in with the `claude` CLI. Direct `anthropic-api` and
`openrouter-api` modes remain available; only those modes ask for weekly and
per-conversation dollar ceilings.

```sh
codex login
toolroll config set chat --provider codex-subscription --as you --token <password>
toolroll serve --repo /path/to/project-a --repo /path/to/project-b
# Open /chat, type your password once to start the conversation, then talk.
```

Coding agents you run elsewhere reach the same plane through the MCP gateway
(see [Toolroll for agents](../agents.md)). Both roads keep the one rule: the
plane never acts on a model's word.

The central team service (`toolroll connect`, the central `toolroll lead
list|create|update|member|transfer`, `toolroll conversation …`, team chat)
and native coding sessions (`toolroll session …`, the `/code` page) are
deprecated: they still work for this release, hidden from help and the
console, print one warning when used, and are removed in the next minor
release.

## Telegram

Settings → Telegram: paste a bot token from @BotFather, then send the bot the
`/pair` code shown. After that:

- Things that need you arrive as messages, and decisions have buttons.
- A flow decision shows the draft with **Approve**, **Edit** and **Send
  back**. Edit asks for your version as a reply; it replaces the draft and
  comes back to approve. Send back asks what should change.
- You can talk to the lead from the chat, and reply to a task's messages
  to talk about that task.

**How your messages reach Toolroll.** With a public hooks address set
(the one webhook triggers use, like a Tailscale Funnel on `/hooks`), Telegram
pushes each message and tap to `…/hooks/telegram` the moment you send it.
Telegram signs every push with a secret only Toolroll knows.
Otherwise, Toolroll asks Telegram for new messages every few seconds.
Settings → Telegram bot token says which one is happening.

While Telegram pushes, no other program can ask for your bot's messages, so
none can go astray. If pushes stop arriving for five minutes, Toolroll
asks for messages itself for a while, then tries pushes again. Nothing is
lost meanwhile: Telegram keeps undelivered messages for a day.

### Telegram from the terminal

The same bridge can be set up and run without the console. A parked decision
arrives as a message with one button per option, and a tap answers it
through the same authenticated path as the CLI and the web view: the hold
lifts, and the next pass resumes the task with the answer in the agent's
brief. No LLM is anywhere in this path.

1. In Telegram, message **@BotFather**: `/newbot`, pick a name and a
   username. Copy the token it hands you.
2. `toolroll bridge telegram token <that-token>`: stored in a 0600 file
   beside the database (or set `TOOLROLL_TELEGRAM_TOKEN`, which wins; or
   paste it into the console's settings card from your phone).
3. `toolroll approver add you --password <yours>` if you have no sign-in
   yet. That name and password are the login for the console and every
   approving act. (Omit `--password` and a high-entropy one is minted and
   printed once instead, better for API/bearer use.)
4. `toolroll bridge telegram pair --as you --token <approver-token>` prints a
   one-time code, good for ten minutes.
5. From your phone, open your bot's chat, press Start, send
   `/pair <that-code>`, then run `toolroll bridge telegram` once to complete
   it. The bot replies with who the chat now answers as.

Then run the pass on a schedule (cron), next to `tick`:

```sh
toolroll bridge telegram        # sends pending, applies taps, exits
```

Once paired, an ordinary message in that chat talks to the same lead as the
console's chat page and `toolroll chat`: the same saved thread, the same
proposal cards (Confirm or Dismiss under each one), with the phone recorded
as the source. Reply to a result message to ask for changes to that exact
result; approvals that take a password, cancelling and publishing still
happen on the computer. Chat from the phone uses your configured membership
provider only; a direct-API configuration is never spent from Telegram.

`bridge telegram status` shows the token source, the binding, and what is
waiting. For answers in seconds instead of at the next cron firing,
`toolroll bridge telegram --follow` stays on the wire: one long-poll actor
holding the same poll lease, so a cron pass overlapping it simply loses the
race. `toolroll watch` embeds the same follower automatically when a bot
token is configured: a tap on your phone answers the decision, the answer
wakes the loop, and the freed task resumes, with no timer in between.

**Away mode.** `toolroll bridge telegram digest --every 2h` (or `--off`, or
the console's settings card) holds routine facts (merges, reports, retries,
plans ready) and sends them as one digest on that cadence. A decision, and
anything that needs a person now (a stalled task, a malformed payload, a gap
that blocks work), still pages the moment it lands. `bridge telegram status`
says how many facts are held.

**Check work from your phone.** In the paired private chat, send `/status`
for recent work across enrolled projects, `/task <id>` for one task's exact
state, recorded evidence, delivery status and next step, or `/help` for the
available commands. These read existing workflow records without a model call
or task mutation. A saved branch, a pending review, and a merged PR stay
distinct. `/status` covers the newest 60 tasks, says when older work is
omitted, and shows up to two rows per group; `/task` can look up older tasks
directly. The computer and bridge must be awake and connected. See
[phone status and its limits](../PHONE_STATUS.md).

**A chat is not a person.** Pairing binds one private chat and one immutable
Telegram user id to one approver credential. Buttons carry opaque one-time
tokens whose meaning lives in the local database: a stolen bot token can read
what was sent and repaint keyboards, but it cannot mint a token, answer as
you, or arm an irreversible choice, which takes a second minted confirmation
tap. Rotating your approver credential strands the chat and every
outstanding button, and the bot token itself is stripped from every agent's
environment.

## Slack, Discord and Teams

Each can be connected under Settings and used to talk to the lead and
confirm its cards. Only one app sends alerts: the one you choose as primary
(Settings → Notifications).

Pairing and approvals work as on Telegram. Each person pairs their own
chat with a code from Settings. A ready result, a failed task, a plan or
a pull request comes with its own buttons (**Accept and finish**,
**Retry**, **Approve & start**, **Merge**), and each asks once more before
it acts. A mode signed before Slack, Discord and Teams could approve covers
Telegram only; sign the mode again to approve plans and merges from them.

A flow decision arrives there with the draft and **Approve**, **Edit** and
**Send back**, as on Telegram. Edit and Send back ask for your next message
in that chat: it becomes the new draft (which comes back to approve) or the
note the card goes back with. Send "cancel" to leave it; the question
lapses after 30 minutes.

## The phone itself

The console works on a phone browser. Add it to your Home Screen (iPhone) to
get notifications from Settings → Notifications → This device. To reach it
away from home, put it on your tailnet: `toolroll up --host 0.0.0.0
--allow-host <your-machine>.ts.net:4180`.

Setup details: [Slack](../slack.md), [Discord](../discord.md), [Teams](../teams.md).
