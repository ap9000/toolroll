# Automatic approvals

Open a project, then **Operating mode**. An instance operator can sign an expiring project policy once (1–7 days) and revoke it in one click. The policy belongs to its signer: other accounts and machine submissions cannot use that person's filing authority.

For a trusted workflow with instructions supplied upfront, choose:

1. **My filings → approve the moment I file them**.
2. **Planner approval → auto-approve plans that preserve my filed contract**.
3. **Reviews → agent-review every finished build**. Both new presets enable reviews; existing signatures retain their original choices.
4. Optionally enable drafted repairs, with a cap of 1–3 attempts. Automatic merging is a separate selection and also requires an existing merge-capable publication grant.

Use Standard to keep safe unattended permissions. Hands-off additionally defaults new filings to full agent permissions. The confirmation screen shows the resolved authority before the password signs it. The signature is bound to that repository as well as the terms; changing the open project invalidates the form.

When filing **Plan task**, supply the goal, acceptance criteria, and paths in **Edit details**. Those fields become the pre-authorized contract. The planner may design the implementation without asking for another scope approval if it reproduces those fields, exclusions, risk, quality, budget, permissions, and agent route exactly. A title-only request still needs approval of the contract the planner invents.

Automatic planner approval is new, explicitly opt-in, and never inherited by existing modes or tasks. Signing a mode does not automatically approve the backlog. New signed-in console filings use the policy; a credentialed `task plan` request or scope filing on an already requested plan can also authorize its current contract. The general proposal/intake door remains unapproved. Templates that are intentionally filed by the signed-in operator follow the same filing policy; mate, scout, coordinator, and revision proposals do not inherit planner authority.

The task page shows when unchanged-plan approval is enabled. The action ledger records both the pre-authorization and the final approval or need for a person. The scope retains the operator and mode digest as its approval basis.

## Touchpoints

| Touchpoint | Automatic behavior |
| --- | --- |
| Signer's complete scope filing | Existing filing policy, now also connected to the main task form |
| Planner's unchanged contract | New explicit option; verified source, plan artifact, and execution terms required |
| Scope amendment or unanswered agent question | Pauses for the operator |
| Build evidence and quality checks | Existing validation remains required |
| Agent review | Runs automatically when enabled; review comments requiring a revision keep their existing human action |
| Drafted repair of named unmet criteria | Optional existing bounded repair policy, at most 3 attempts; integrity and no-progress checks still stop it |
| Merge | Optional existing automatic merge policy, with a publication grant and green CI on the exact commit |
| A provider's plan running out | The attempt fails with its reason and waits; nothing switches to another agent or account |

Expiry, revocation, access changes, mode renewal, source drift, missing or tampered plan evidence, and stale worker leases cannot silently widen approval. The final plan, approval, and ledger event commit under the same fenced transaction. A failed transaction grants nothing. Already-running work retains the existing stop/recovery behavior.

CLI example, using the existing credential prompt:

```sh
toolroll mode set --repo /path/to/project --name standard --auto-approve true --plan-auto --days 1 --as owner
toolroll task plan task-id --as owner
```

Schema v55 adds the pending plan-authorization record. Migration preserves existing mode bytes and project grants; older binaries must not open the upgraded database. This source change does not enable a policy or migrate the running desktop installation automatically.
