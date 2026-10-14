# Quality and agent routing

## Quality modes

The **quality mode** setting selects routine or stronger configured agents.
**Strict / release** requests the stronger tier; it does not start an isolated
reviewer or automatic repair. The choice is signed into each scope, survives
later global changes, and remains visible in approval and run details.
Repository checks still run through the approved verifier. Publication and
deployment require their own authority and checks.

## Explainable phase routing

Which agent plans, builds, and repairs a task is decided once, from
signed facts, and written down with its reasons. The route reads the task's
**size** (small, medium, large, risky or not), its quality mode, what the
acceptance rubric demands (screenshots, manual review), how far a live
operating mode may carry the result unattended, each provider's plan room, and
the agents you configured for each phase. Strength is never
inferred from a model's name: the ordinary phase row is the routine tier, and
`config set <phase> --tier strong --provider <p> --model <m>` names the agent
large or risky, strict, screenshot-proof, and automerge routes reach for. With no
strong row, a demanding task keeps the default and says so.

```
toolroll task route <id> --size large --as you --token <t>
toolroll task route <id>                     # every leg, its reason, its readiness
toolroll task route <id> --phase build --provider codex --model gpt-5-codex --as you --token <t>
toolroll task route <id> --clear-phase build --as you --token <t>
toolroll providers --report --runner <name> --token <t>   # this machine's readiness
```

Every leg is **exact**: approvals bind a provider *and* a model id for the
planner, builder, and repair alike, so each phase names its model
once (`config set plan --provider claude --model <m>`, and the same for
`build`; repair inherits the build's model unless a same-provider
repair row names another). A phase without an exact model, a repair row on
another provider, or an unknown provider files the scope **unresolved** with
the words to fix it — nothing is guessed or substituted. Every override names
an exact model too, and a plan override becomes the planner pin.

Every override is recorded under the approver's name, in one transaction that
checks the scope you were reading is still the one on file (`--digest`, or the
form's own field). Approval seals the route — routine-shaped routes included —
exactly as it seals the execution profile; a later size change or override
re-files the scope and the old
approval reads stale, while a global configuration change can never rewrite a
sealed route. A row filed before routing existed is recognised by a durable
marker and stays governed by its sealed profile; a routed row whose route data
is missing or unreadable is refused everywhere until re-filed and approved
again. Repairs always stay on the build provider. Runners report provider
readiness without spending — at startup and with `providers --report`, never
on a timer — and the task page, the chat, and `task show` say **ready**,
**unavailable** (with the runner's own words), or **unknown** beside the
agents, outside what the approval signs; an unavailable provider halts before
any claim and is never substituted. When a provider's plan runs out mid-build,
the attempt fails with its reason like any other failure and the task waits
for a retry or for you; nothing switches to another agent or account on its
own. Every run is stamped with its route and the actual provider and model at
admission — set once; a run that would spend as anything else refuses.

Admission proves that stamp before any run row exists: its shape (a known
phase, provenance word, and provider; a digest; an exact, argv-safe model id),
its phase against the run's role, its provider and model against what the run
would spend as, and its provenance against the authority the task actually
holds — the sealed route's digest and that phase's exact leg, or a proven
pre-routing row for `legacy`, whose stamp must name the very sealed profile
(and, for a build or repair, its exact pair) — the bare word `legacy` belongs
only to a task with no scope. A task filed under routing never opens an
unstamped run, and the store dictates nothing: every planner, builder, scout,
reviewer, and repair turn **presents** the exact authority it holds
(`routeAuthorityFor` puts it in the caller's hands, in words), and a missing,
forged, stale, or inexact stamp opens no row — the refusal names what would
have had to be presented. A repair turn mends exactly its same-task parent
under the claim that holds the task now. A run admitted under a route the scope
has since re-sealed away refuses to spend. Malformed authority — corrupt route
or profile JSON, a model id that is not one, a turn bound or clock that is not
a positive whole number — fails closed in words and never shrinks.

Fallback chains and the declared risk level were removed (schema v115). An
unfinished task that was filed or approved with fallback agents asks again
after the update — its scope says so, and saving it once chooses its
agents; finished tasks and routes sealed at elevated or high risk keep their
exact bytes and still verify.

Codex resumes carry their sandbox as a configuration override (`-c
sandbox_mode=…`): `codex exec resume` has no `--sandbox` flag, so a structured
correction or repair-by-resume handed one exited before it initialized. A
resume the harness refuses by its own protocol, or never comes up for, ends
the planning attempt with its typed reason — the recorded session is not
resumed twice — and the next attempt, after the planning backoff, is a fresh
planner root in a fresh session.

A **scheduled flow** with a standing order files an ordinary task each time
it fires: the order's terms (goal, exclusions, touches, requirements, success
checks, per-run budget) are copied into the task's scope unchanged, and the
task waits for approval under the project's approval rules like any other
proposal. A standing order moved over from an old routine keeps that routine's
approval and its frozen agents while they still verify: each firing re-hashes
the frozen snapshot against the approval, holds the build and repair legs to
the sealed profile's exact provider and model, and rolls the whole firing back
unless the task seals under it — a later `config set` cannot re-route it. Once
that approval no longer verifies, each firing says why and waits for approval
as an ordinary proposal. `toolroll flows show` prints a standing order's
terms; `toolroll flows trigger pause|resume` (or **Resume** on the flow canvas)
stops and starts its schedule.

Every approval surface — the task page, the focused chat, and `/next` — shows
the same concise line of exact agents above the password, with why stronger
agents run explained in plain words and the runtime limits one tap away; changing
any agent invalidates the approval every surface signed under. Where no yes
could bind — an unreadable route, a route that cannot run, or a pre-routing
row whose old approval no longer stands — those surfaces mint no nonce and
show no password or approve button, only the reason and the act that opens it
(re-file the scope or change the agents) — the inbox row reads *needs
attention* rather than *review & approve*; an old approval already on a
pre-routing row is grandfathered, but no new yes lands on it. In the demo sandbox, Chat is a
scripted lead that never calls a model; real chat evidence is a subscription-backed plane. The task page's controls offer,
per role, only the agents you configured *for that role* (gemini never
reviews; repairs stay on the build provider), a current agent the
configuration no longer names is shown for what runs today and never offered
again, and each size says what it does — truthfully under strict quality and
screenshot proof too. Chat reads the same route (`get_agents`)
and proposes one confirmation-gated change (`propose_agents`) — a size, one
role switched to a listed agent, or a hand-picked role cleared — which lands,
when you confirm the card, through the same authenticated route edit the page
uses; the chosen agent is re-proved against the role's configured choices
*inside* that transaction, so a card drafted against yesterday's
configuration changes nothing.

See also [Models](../MODELS.md) for where model lists come from and the default agents.
