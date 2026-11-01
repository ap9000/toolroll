# Signed webhooks into tasks (v6)

v2 answered Codex's review of v1 (NO-GO, 13 findings); those answers are marked **[Rn]**. v3 answers round 2
(8 closed; R3, R7, R9, R12 and R13 open; new N1–N4); those answers are marked **[r2-…]**. v4 answers round 3 (R3 and N4 open, new N5); those answers are marked **[r3-…]**. v5 answers round 4 (R3, N4) **[r4-…]**. v6 answers round 5 by making recovery manual **[r5-R3]**; round 6 was GO.

## Where we start

A flow's `webhook` trigger takes any JSON at a secret address (`/hooks/flow/<token>`) and makes a card. A card in a
build or research zone is filed as a task through `workStage → fileTaskProposal`, and that task waits for an approval.
The flow-unattended grant covers **only** cards that the flow's own schedule fired (`unattendedCoverageFor`), so a
webhook card always waits for a person. This plan keeps that boundary, and a test pins it. **[R13]**

GitHub and Linear deliveries are signed and checked.

The gaps:
1. The generic webhook proves nothing about its sender.
2. Duplicates are decided by headers the sender controls.
3. Nothing limits a delivery flood.
4. A card or task doesn't say where it came from. The task itself doesn't carry the outside reference.

Not in this plan:
- A webhook-to-task road that skips flows. The filing path already owns approval, budget and zone checks; Codex
  agreed.
- Scheduled quiet tasks.

## 1. How a webhook proves itself

The webhook trigger config gains `sender`, one of the following. A value Toolroll doesn't know fails closed.

| `sender` | checked | reads the body as |
|---|---|---|
| `none` | the secret address only (today's behavior; absent = `none`) | dot-paths (`titleField`, `bodyField`, `idField`, `urlField`) |
| `standard` | [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) v1 | dot-paths |
| `github-style` | `x-hub-signature-256: sha256=<hex>`, HMAC-SHA256 of the raw body (GitHub's own header and prefix) **[R7]** | dot-paths |
| `sentry` | `sentry-hook-signature`: hex HMAC-SHA256 of the raw body, keyed by the integration's Client Secret | the Sentry reader (§2) |
| `vercel` | `x-vercel-signature`: hex HMAC-SHA1 of the raw body, keyed by the webhook secret, or the integration's client secret for an integration webhook | the Vercel reader (§2) |

How the check runs **[R7]**:
- It runs over the raw bytes, before parsing. The existing GitHub and Linear paths are reordered the same way.
- Comparisons are constant-time on equal-length buffers.
- A security header sent more than once, or missing, is refused. **[r2-R7]** Node comma-joins repeated custom headers
  in `request.headers`, so the handler passes `request.headersDistinct` (Node ≥ 18.3; we run 22). Every signature,
  timestamp and id header must have exactly one value. A test sends real repeated header lines over a socket.
- For Standard Webhooks:
  - The secret's `whsec_` prefix is stripped and the base64 is **decoded to key bytes**.
  - `webhook-timestamp` must be a decimal integer in Unix **seconds**, within ±5 min of now.
  - The signed content is `${webhook-id}.${webhook-timestamp}.${raw body}`, using the header text exactly as sent.
  - `webhook-signature` is a space-separated list. Any `v1,<base64>` entry may match. A malformed entry is skipped,
    and a list with no well-formed `v1` entry is refused.
- Sentry setup recommends an Internal Integration. A public integration signs the same way; Sentry's legacy
  "WebHooks" plugin doesn't sign at all. **[R7]**
- A bad, missing or stale signature writes **nothing**: no receipt, no last outcome. It is counted only in the abuse
  counter (§4).

Provisioning is separate from creating the trigger **[R6]**:
- Creating a trigger never makes a secret: not from the panel, the gallery (`useGalleryTemplate`) or an import
  (`importFlow`). A signed trigger starts **not ready**. Its delivery gets a 401 that says the secret isn't set, and
  `hookReady` is false.
- The Triggers panel's **Set up** action is the one place credentials are made, behind the console's session and
  password where the panel already asks for one.
  - `standard` and `github-style`: Toolroll generates the secret and shows the address and secret together, once.
  - `sentry` and `vercel`: Toolroll makes and shows the address, and the provider's secret is pasted. Allowed
    shapes: Sentry is hex of 32–128 characters; Vercel is alphanumeric of 16–200; standard is `whsec_` plus base64
    of 24–64 bytes.
- **Renew address** keeps the secret. **Replace secret** generates or asks again. The old secret stops working at
  once.
- Chat (the lead) may link to the panel's Set up action. It never takes or shows a secret.
- Secrets are stored per trigger through `saveHookSecret`. They never go into the config, the export, a card, a task
  or a log.

Changing `sender` in place **[R9, r2-R9, r2-N3]**:
- It is a new `TriggerVerb`, `sender`, backed by a new validated store operation, `updateFlowTriggerConfig`. That
  operation re-runs `validateTriggerConfig` and writes `config_json` and the credential generation in one transaction.
  The trigger keeps its ID, address and receipt history.
- **Credential generation.** `flow_trigger` gains `hook_generation` (v126). Secrets are saved under
  `(trigger, generation)`. A sender change or Replace secret bumps the generation in the same transaction as the
  config. Verification reads only the current generation's secret, so an old secret file that failed to delete can
  never authenticate.
- **Upgrade** **[r3-N5]**: generation 0 *is* today's credential address (`flow-hook.<trigger>` and
  `flow-hooks/<trigger>.json`). v126 sets `hook_generation = 0` on every existing trigger, so configured GitHub and
  Linear triggers keep authenticating with no credential moved. Generations ≥ 1 use new addresses,
  `flow-hook.<trigger>.g<n>`. Lookup reads exactly the current generation's address and never falls back to
  generation 0 once it has advanced. Tests:
  - A pre-v126 configured GitHub trigger authenticates after the upgrade.
  - After Replace secret, with deleting the legacy file made to fail, the old secret is refused. Deleting it is best-effort cleanup. A test injects a deletion failure and proves the old secret
  is refused.
- Receipt keys are namespaced by **how the delivery was proven** (§3). A key an unsigned delivery reserved can never
  satisfy, or block, a signed one.
- The new fields (`sender`, `project`, `team`, `idField`, `urlField`) go through the input schema, the file schema,
  the stored schema, the saved defaults (absent = `none` or `null`), `triggerOf`'s export selection, import
  validation and the generated JSON schema. Each has a round-trip test.

## 2. Provider readers **[R4, R5, R12]**

A signature proves who sent a delivery. It doesn't prove the delivery belongs in this flow. So `sentry` and `vercel`
don't use dot-paths. Each has a reader that:
- checks the payload's shape and action,
- checks the configured scope,
- and only then gives the item its identity.

Anything else gets `202 Ignored: <why>`. Its receipt keys on the delivery hash, so it never uses up the identity of
the thing it names.

The readers are written against **real captured fixtures**. The first build step captures one delivery from each
provider into `src/fixtures/webhooks/`, with secrets replaced and the HMAC recomputed with a test key, as the
fallback-fixtures road did.

**Sentry**
- Issue alerts (`action: "triggered"`):
  - Identity: `data.event.issue_id`.
  - Link: `data.event.web_url`.
  - Title: `data.event.title`.
  - Details: `data.event.culprit`.
- New issues (`action: "created"` with `data.issue`):
  - Identity: `data.issue.id`.
  - Link: `data.issue.web_url`.
  - Title: `data.issue.title`.
- Any other action is ignored. That includes installation, resolved and metric alerts.
- Scope: the config's optional `project` must equal the event's project ID or slug, taken from the body only (never
  from the unsigned `sentry-hook-resource` header). When `project` is unset, the panel warns: "Any project this
  integration sees can add cards."

**Vercel**
- Only `type: "deployment.error"`.
- Identity: `payload.deployment.id`.
- Link: `payload.links.deployment`, the inspection page.
- Title: `payload.deployment.name`.
- Scope: the config's optional `project` must equal `payload.project.id`, and `team` must equal `payload.team.id`.
  Both are taken from the body.

The generic senders (`none`, `standard`, `github-style`) keep their dot-paths. They gain `idField` and `urlField`:
- A configured `idField` that is missing, empty, over 120 characters, or holding a control character makes **no
  card**. It records `skipped: id missing`, so it never falls back to some other identity. **[R8]**

**Every outside field is screened before anything is written** **[r2-R12]**. That covers the identity, link, title,
details and scope values, before a receipt key, `item_json`, card or task snapshot exists.
- The screen is the same secret check `flowCardText` runs on title and description, extended to every field.
- An identity that fails the screen is never used in a key. The receipt keys on the body hash and records
  `skipped: it looked like it held a key or password`.
- Held items are screened before they are stored, not when they are drained.

**Every link** **[R12]**:
- Absolute `https:`, at most 2,000 characters.
- No user information, **query or fragment**, which are stripped.
- Passed through the same secret check as the card text.
- Sentry links must be on `sentry.io` or a subdomain of it. Vercel links must be on `vercel.com`.
- The link is shown as its host plus path, never as a bare label.

## 3. Receipts: what was received, and what it became **[R1, R8]**

`flow_trigger_event` gains `state` (v126): `accepted`, `skipped`, `held` or `ignored`. Rows written before v126 read
as `accepted` when they have a card and `skipped` otherwise.

Keys:
Every v3 key starts with the sender that proved it **[r2-R9]**: `v3:<sender>:…`, with `sender` one of `none`,
`standard`, `github-style`, `sentry` or `vercel`. Changing the sender starts a fresh namespace, so nothing unsigned
vouches for, or blocks, anything signed.
1. An entity identity (a provider reader's, or a configured `idField`) → `v3:<sender>:id:<value>`. This is grouping:
   the same Sentry issue or Vercel deployment makes one card per trigger.
2. Otherwise, `standard` → `v3:standard:wid:<webhook-id>`. The ID is covered by the signature.
3. Otherwise, a signed sender → `v3:<sender>:body:<sha256>`. Two byte-identical signed requests are one: a generic sender that
   needs repeats should use `standard`, and the panel says so.
4. `none` with no `idField` → today's header-then-hash key (`hook:…`), unchanged. With `idField` →
   `v3:none:id:<value>`.

Answers for a key already present:
- `accepted` → "Already received" (and the panel names the card).
- `skipped` → "Already received; it wasn't added: <reason>".
- `ignored` → "Already received".
- `held` → "Already received; waiting for room".

The answer never claims "a card" that doesn't exist.

Accepted limits on replay protection, written down **[R8]**:
- Sentry, Vercel and github-style sign the body only. Anyone holding an old valid delivery that this trigger never
  received can replay it once.
- Entity grouping limits a replay to one card per entity. Standard Webhooks' signed timestamp closes this window.
- A Sentry issue that comes back after its card is done makes no new card on that trigger.

## 4. Floods **[R2, R3]**

Two separate counters, so a stranger holding a leaked address can't crowd out real traffic:
- **Abuse counter** (in memory, per trigger, plus one shared bucket for unknown addresses):
  - It counts deliveries that fail authentication: bad or missing signature, stale timestamp, not ready.
  - Over 60 a minute → `429` with `Retry-After` on further failures. Writes nothing.
  - A delivery that authenticates is never refused by this counter.
- **Unsigned (`none`) triggers** have nothing to authenticate, so every delivery counts toward the same 60 a minute.
  This is documented as lossy under a flood.

The **hourly card limit**, 30 cards per trigger per rolling hour, counts **`accepted_at`**, the moment the card was
made, not when the delivery arrived **[r2-N1]**. `flow_trigger_event` keeps `at` as the arrival time and gains
`accepted_at` (v126), which is written in the card's transaction. Rows from before v126 take `at`. Draining a queue
that has aged past an hour still admits at most 30 an hour; a test drains an aged queue after a restart. The limit is decided **inside the same write transaction**
that checks the receipt, counts, creates the card and writes the receipt. That holds across connections.
- v126 adds the index `flow_trigger_event(trigger, accepted_at)`.
- A test has two store handles competing for the 30th slot.
- An existing receipt answers as above even while the limit is full.

**Over the limit, a signed delivery is held, not dropped**:
- Its receipt is written as `held`, with its prepared item (title, details, link, identity, verification) stored in a
  new `item_json` column. The item is bounded by the card's own limits.
- The answer is `202 Held: it will be added when there's room`.
- Each trigger pass (`runFlowTriggers`) moves held receipts to cards, oldest first, under the same transactional limit.
  `held → accepted` is one UPDATE in the card's transaction, and the card rolls back if it fails.
- At most 200 held receipts per trigger. **Beyond that, signed intake is lossy** **[r2-R3]**: the answer is `503`
  and nothing about the delivery is written. What is kept:
  - `flow_trigger` gains `dropped_count` and `dropped_since` (v126), incremented atomically. The panel shows "N
    deliveries were turned away since <time>" until someone clears it. Later successful traffic can't hide it the way
    it overwrites `last_outcome`.
  - **Recovery is manual** **[r5-R3]**. v3–v5 specified an automatic catch-up poll. Round 5 showed it can't be made
    complete without a much larger design:
    - workflow runs that last longer than any lookback window
    - issues and pull requests closed while the queue drains
    - label-added semantics that a state listing can't reproduce
    - GitHub's 1,000-result search ceiling

    Loss only begins after 200 deliveries are already held on one trigger, so v6 drops the catch-up and **accepts the
    loss**, stated plainly:
    - The durable `dropped_count` / `dropped_since` banner names how many deliveries were turned away, and since when.
    - The banner gives the manual path for each sender:
      - GitHub: Recent Deliveries → Redeliver.
      - Linear: the webhook's delivery log.
      - Sentry, Vercel and Standard senders: their delivery logs where they keep one.
    - Redelivered items take the same receipt keys, so nothing doubles.
    - The poll-mode GitHub and Linear triggers are unchanged, apart from the deduplication fix below.

    One thing from the catch-up work stays: ordinary polling (`checkTrigger`) deduplicates **before** its 10-item
    batch, so known items can't starve unseen ones. A test reproduces the 30-item case.
- Unsigned triggers over the hourly limit get `429` and nothing written. A stranger's flood shouldn't fill the queue.

## 5. Where it came from, kept with the task **[R10, R11, R12]**

**At receipt**, the card's `source` gains:
- `verified`: the sender kind that proved it, or `"none"`.
- `external`: `{ id, url }`.
- `receipt`: the key.

`readFlowCardSource` round-trips all three.

**Who filed it** **[r2-N2]**: no name is ever read as automation.
- `flow_card` gains `created_kind` (v126): `person` or `automation`. It is set at the trusted creation boundary
  (`makeCard` from a hook, schedule or poll → `automation`; a person adding a card → `person`).
- Rows before v126 read as `person`, which is today's behavior.
- `workStage` passes `{ name, kind }` from the card row instead of `filerFor(createdBy)`. `filerFor`'s name rules are
  unchanged.
- A regression test has an account literally named `hook:sentry` add a card by hand. It is still the requester, and
  `notRequester` still refuses its own approval.
- A revision shows its real requester separately from the inherited origin line **[r2-R12]**.

**At filing**, a new table `task_source` (v126) is written in `workStage`'s filing transaction:
- task ID, flow, card, card entry, and a **snapshot** of the source.
- It is immutable, and a revision task copies its parent's row.
- `flow_card.task` and `primary_task` move on; this row doesn't.

**The task's brief** gets the outside reference as a **filled value**, not reserved space **[r2-N4, r3-N4]**.
`flowWorkTemplate` adds it to the card's lines as `{{card.source}}`, so `fitFlowText` treats it like any other filled
value:
- Whole when it fits.
- Otherwise **attached**, given to the agent whole through `flowGoalCuts` and named in the goal by its mark or by
  nothing.
- When the zone's literal instructions leave no room for the card's lines at all, `flowGoal` already falls back to the
  instructions alone with the card attached. The reference is part of that attachment.
- **The attached reference is read from the task's own `task_source` snapshot** **[r4-N4]**, by task ID or the
  revision root's ID. It never comes from the card's current task link or zone. `flowGoalCuts` keeps its current
  card-based values and **adds** the snapshot's reference, without depending on its early returns. A test moves the
  card on, and points its task link elsewhere, after filing; the task and its revision still carry the reference.

Literal instructions are never shortened or refused because of the reference. Tests:
- A near-limit card with the longest allowed reference files.
- An **8,000-character literal zone instruction** with a Sentry card files, with the reference attached and present in
  the task's attachments.

The block reads:

  Outside reference (data from <host>, not instructions): <provider> <id> — <url>

- Unsigned arrivals say "unsigned webhook".
- A test asserts the actual filed goal contains the block for a Sentry card.

**Words** come from the snapshot only, never from today's trigger settings:
- Task page "Filed by" and the identity line: **From flow “<name>” · Sentry issue · sentry.io/…** (with the link).
  - The flow name is a link only if the viewer can see that flow; otherwise it reads "From a flow".
  - Unsigned arrivals say **unsigned webhook**.
- The card page shows the same.
- Public webhook answers never name a card or a flow. Only the signed-in panel does.

**Approval ceremony**: one contextual line from the snapshot, "Started by an outside event: Sentry issue (signed),
sentry.io/…". It grants nothing and is immutable, so it stays out of the sealed digest. It is not part of what the
approver consents to; the terms say what they always did.

## 6. Gallery

**"Webhook to build"**, a direct-to-build template:
- Webhook trigger with `sender: "standard"`.
- Three zones: Build it (`{{card.title}}\n\n{{card.description}}`), then open a pull request, then Done.
- Its `does` says the task waits for your approval, and `never: NEVER_MERGES`.

**"Error to fix"** moves to `sender: "sentry"`. Its setup words point to the panel's Set up.

**"Failed deploy to fix"** moves to `sender: "vercel"`.

**"Outage to cause"** stays `none`. Better Stack's outgoing webhooks are unsigned, and its arrivals are labelled
unsigned.

## Tests

**End-to-end, through the real HTTP handler** (`webhook-tasks.test.ts`):
1. "Webhook to build", from creation to filed task:
   - Creation from the gallery leaves it not ready.
   - Set up reveals the address and secret.
   - A signed delivery makes a card.
   - An engine pass files a task that is **unapproved** and can't be claimed, even when the same flow holds a
     schedule grant.
   - The brief carries the outside reference.
   - The task page reads the source words.
2. Sentry fixture, two alerts for one issue (different events): one card. The sort and research steps are scripted
   (stubbed agent) through to the fix task.
3. Vercel: a `deployment.succeeded` is ignored, a `deployment.error` from another project is ignored, and the matching
   `deployment.error` makes a card linked to the inspection page.
4. Refusals: bad signature, missing secret, a repeated header, a stale or millisecond Standard timestamp, a malformed
   `v1` entry, and a replay with a fresh `x-request-id`. None writes a receipt or the last outcome.
5. Floods:
   - 61 bad signatures in a minute → 429, and a signed delivery right after is still taken.
   - The 31st card in an hour is held, and the next pass after the hour makes it.
   - Two store handles compete for the last slot.
   - The 201st held delivery gets 503.
6. Changing the sender in place keeps the trigger and its history, and an old unsigned key doesn't satisfy a v3 key.
7. Export and import round-trip `sender`, `project`, `team`, `idField` and `urlField`, never a secret. An import
   arrives not ready.
8. Links: a query string holding a token is stripped, an off-host Sentry link is dropped, and a link that looks like a
   secret is dropped.

9. **[r2-R13]** Actual controls:
   - Renew address keeps the secret.
   - Replace secret refuses the old one.
   - A sender change with secret deletion failing refuses the old one.
   - An import or gallery trigger stays not ready.
   - Queue states: held, drained, aged past an hour, full (503, dropped count and the manual redelivery path shown).
   - Migration: `none` with `idField` switched to signed makes the signed entity a card.
   - A pre-v126 database opens and reads its old receipts.

**Unit tests**: each scheme against fixed vectors (Standard Webhooks' spec vector; HMAC vectors for the others), with
raw non-ASCII bytes.

**In the browser**, on desktop and phone **[r2-R13]**:
- The full journey: Set up → address and secret shown once → a delivery → the card and task → approve → the result
  → a send-back with a note → the revision keeps the source line and shows its own requester.
- The panel's other states:
  - empty (no secret yet)
  - not ready
  - an unsigned warning
  - an unscoped Sentry warning
  - a dropped-deliveries banner
  - a long source link and title
  - a credential failure (a wrong pasted shape)

## Order

Each step gets a Codex review before the next:
1. v126 schema and receipts.
2. Signing, provisioning and changing the sender.
3. The provider readers, with fixtures.
4. Floods and holding.
5. Source snapshot, the brief and the words.
6. Gallery and end-to-end.

**Fixture blocker:** the Sentry and Vercel readers need one real delivery from each. If Alex has no Sentry or Vercel
project to point at a capture address, the readers are written from the providers' documented examples, and they
stay marked unverified on the panel until a real delivery has passed through them.
