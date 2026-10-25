/**
 * Which approval authorities stand, as ONE SQL predicate every dispatch belt shares (docs/plans/approval-policy.md
 * §1.5): the queue's dispatch query, the work index, and the claim and build belts (`Store.modeApprovalLive`).
 *
 * An allowlist, never a deny-list: a person's yes (`password`, `chat`) stands; a mode or a flow grant stands while its
 * signature does; a standing order's firing (`schedule`) stands while its approver can still approve in the project.
 * Everything else — the lead (`lead`, which phase 1 never lets stand), a null basis, a word this code doesn't write —
 * stands on nothing.
 */
import { grantStandsSql } from "./flow-unattended.js";
import { accountReachesSql } from "./project-access.js";

/** SQL over a `task_scope` alias and a repo expression: whether that row's approval authority stands at `now` (an SQL
 * expression, used exactly twice, as the mode and grant clauses always have). It never asks whether the row is approved. */
export const authorityStandsSql = (scope: string, repo: string, now: string): string =>
  // COALESCE: a NULL basis makes the OR chain NULL, and NOT NULL would read as "not dead"; NULL stands on nothing.
  `COALESCE(((COALESCE(${scope}.approval_basis, '') IN ('password', 'chat') AND ${notMachineSealSql(scope)})
    OR (${scope}.approval_basis = 'mode' AND EXISTS (SELECT 1 FROM operating_mode om
          JOIN approver signer ON signer.name = om.signed_by
         WHERE om.repo = ${repo} AND om.revoked_at IS NULL AND om.absolute_expiry > ${now} AND om.digest = ${scope}.mode_digest
           AND signer.revoked_at IS NULL AND signer.role = 'approver' AND ${accountReachesSql("signer", repo)}))
    OR (${scope}.approval_basis = 'grant' AND ${grantStandsSql(`${scope}.mode_digest`, now, repo)})
    OR (${scope}.approval_basis = 'schedule' AND EXISTS (SELECT 1 FROM approver sched
          WHERE sched.name = ${scope}.approved_by AND sched.revoked_at IS NULL AND sched.role = 'approver'
            AND ${accountReachesSql("sched", repo)}))), 0)`;

/** The proof outcomes a machine credential leaves (scope.ts AuthMethod). */
const MACHINE_PROOFS = "('lead-token', 'remote-token')";

/** SQL: the newest proof row this approver left for this row's approved bytes (either detail form), or NULL. */
export const sealProofSql = (scope: string): string =>
  `(SELECT p.outcome FROM action_ledger p WHERE p.task_id = ${scope}.task_id AND p.action = 'approval proved' AND p.actor = ${scope}.approved_by
      AND (p.detail LIKE '% · digest ' || ${scope}.approved_digest OR p.detail LIKE '%"digest":"' || ${scope}.approved_digest || '"%')
    ORDER BY p.id DESC LIMIT 1)`;

/**
 * SQL: a person-road seal (`password`, `chat`) that a machine credential did not make. Before the fix a lead token or a
 * remote API token sealed through the person's road and the row says `password`; the record of what happened — the
 * proof row (`lead-token`, `remote-token`) or the lead's own task act at that instant — says otherwise, and wins. A
 * seal with no proof row at all predates proof rows and is grandfathered for dispatch (it is still never a person's
 * approval for release, deploy or votes: scope.ts personApprovalOf).
 */
export const notMachineSealSql = (scope: string): string =>
  `(COALESCE(${sealProofSql(scope)}, '') NOT IN ${MACHINE_PROOFS}
    AND NOT EXISTS (SELECT 1 FROM task_act la JOIN task_ref lr ON lr.id = la.task_ref AND lr.backend = 'built-in'
                     WHERE lr.external_id = ${scope}.task_id AND la.act = 'approved' AND la.lead = 1
                       AND la.account = ${scope}.approved_by AND la.at = ${scope}.approved_at))`;
