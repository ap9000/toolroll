/**
 * Which approval authorities stand, as ONE SQL predicate every dispatch belt shares (docs/plans/approval-policy.md
 * §1.5): the queue's dispatch query, the work index, and the claim and build belts (`Store.modeApprovalLive`).
 *
 * An allowlist, never a deny-list: a person's yes (`password`, `chat`) stands unless a machine made that seal; a mode
 * or a flow grant stands while its signature does; a standing order's firing (`schedule`, or an old firing stored as
 * `password`) stands while its approver can still approve in the project. Everything else — the lead (`lead`, which
 * phase 1 never lets stand), a null basis, a word this code doesn't write — stands on nothing.
 *
 * The seal's origin is read from the acts recorded AT the seal's own instant, exactly as scope.ts sealOriginOf reads
 * it: an older proof for the same bytes never vouches for a later seal.
 */
import { grantStandsSql } from "./flow-unattended.js";
import { accountReachesSql } from "./project-access.js";

/** The proofs a person gives (src/person-proof.ts), as an SQL list. */
const PERSON_PROOFS = "('password-now', 'sso-now', 'fresh-password', 'fresh-sso', 'session', 'cli-login', 'chat', 'passkey')";

/** SQL over a `task_scope` alias and a repo expression: whether that row's approval authority stands at `now` (an SQL
 * expression, used exactly twice, as the mode and grant clauses always have). It never asks whether the row is approved.
 * COALESCE: a NULL basis would make the OR chain NULL, and NOT NULL reads as "not dead"; NULL stands on nothing. */
export const authorityStandsSql = (scope: string, repo: string, now: string): string =>
  `COALESCE(((COALESCE(${scope}.approval_basis, '') IN ('password', 'chat') AND NOT ${machineSealSql(scope)}
        AND (${personSealSql(scope)} OR NOT ${automationSql(scope)} OR ${approverStandsSql(scope, repo)}))
    OR (${scope}.approval_basis = 'mode' AND EXISTS (SELECT 1 FROM operating_mode om
          JOIN approver signer ON signer.name = om.signed_by
         WHERE om.repo = ${repo} AND om.revoked_at IS NULL AND om.absolute_expiry > ${now} AND om.digest = ${scope}.mode_digest
           AND signer.revoked_at IS NULL AND signer.role = 'approver' AND ${accountReachesSql("signer", repo)}))
    OR (${scope}.approval_basis = 'grant' AND ${grantStandsSql(`${scope}.mode_digest`, now, repo)})
    OR (${scope}.approval_basis = 'schedule' AND ${approverStandsSql(scope, repo)})), 0)`;

/** SQL: a machine made this seal — any proof at the seal's instant that isn't a person's (whatever its detail says,
 * parsed or not: fail closed), or the lead's own approval act then. */
export const machineSealSql = (scope: string): string =>
  `(EXISTS (SELECT 1 FROM action_ledger mp WHERE mp.task_id = ${scope}.task_id AND mp.action = 'approval proved'
       AND mp.actor = ${scope}.approved_by AND mp.at = ${scope}.approved_at AND mp.outcome NOT IN ${PERSON_PROOFS})
    OR EXISTS (SELECT 1 FROM task_act la JOIN task_ref lr ON lr.id = la.task_ref AND lr.backend = 'built-in'
       WHERE lr.external_id = ${scope}.task_id AND la.act = 'approved' AND la.lead = 1
         AND la.account = ${scope}.approved_by AND la.at = ${scope}.approved_at))`;

/** SQL: a person's proof at the seal's instant for these exact bytes, its detail parsed (the versioned JSON record,
 * whitespace and all, or the legacy text). */
export const personSealSql = (scope: string): string =>
  `EXISTS (SELECT 1 FROM action_ledger pp WHERE pp.task_id = ${scope}.task_id AND pp.action = 'approval proved'
      AND pp.actor = ${scope}.approved_by AND pp.at = ${scope}.approved_at AND pp.outcome IN ${PERSON_PROOFS}
      AND CASE WHEN json_valid(pp.detail) THEN json_extract(pp.detail, '$.v') = 1 AND json_type(pp.detail, '$.digest') = 'text'
                                            AND json_extract(pp.detail, '$.digest') = ${scope}.approved_digest
               ELSE pp.detail LIKE '% · generation % · digest ' || ${scope}.approved_digest END)`;

/** SQL: the task a standing order's firing filed (its own record of the firing). */
const automationSql = (scope: string): string => `EXISTS (SELECT 1 FROM flow_trigger_event fe WHERE fe.task = ${scope}.task_id)`;

/** SQL: the seal's approver can still approve in the project. */
const approverStandsSql = (scope: string, repo: string): string =>
  `EXISTS (SELECT 1 FROM approver sched WHERE sched.name = ${scope}.approved_by AND sched.revoked_at IS NULL AND sched.role = 'approver'
      AND ${accountReachesSql("sched", repo)})`;
