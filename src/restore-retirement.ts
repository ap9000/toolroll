/**
 * Live restore authority retirement and recovery-generation rotation
 * (central-workspace-server-contract.md §Blocking recovery policy).
 *
 * Runs inside the pre-swap transaction on the staged database copy inside
 * `backup.ts:restoreDatabase`, BEFORE the restored file replaces the live
 * database. Keeps the stable `workspace_id` immutable, rotates
 * `recovery_generation` to a fresh 32-hex value distinct from both the backup
 * and the replaced database, and retires all restored remote/browser
 * credential authority (chat pairings, pairing codes and chat buttons included)
 * using each class's trusted owner functions.
 */
import { randomBytes } from "node:crypto";
import { ChatCore } from "./chat-core.js";
import { CHAT_PROVIDERS } from "./contracts/chat-tables.js";
import { revokeCoordinator } from "./coordinator.js";
import { autoPublishHeld, holdAutoPublish, PUBLISH_ALLOWED_ACTION, PUBLISH_HELD_ACTION } from "./release-auto.js";
import type { Store } from "./store.js";
import { retireRestoredAutoUpdates, RESTORED_AUTO_UPDATES_OFF } from "./auto-update-schema.js";
import { RECOVERY_GENERATION_PATTERN, WORKSPACE_ID_PATTERN } from "./workspace-identity-schema.js";

export type RestoreRetirementSummary = {
  workspaceId: string;
  previousRecoveryGeneration: string;
  recoveryGeneration: string;
  apiTokens: number;
  leadCredentials: number;
  coordinatorCredentials: number;
  oauthRows: number;
  webSessions: number;
  publicationGrants: number;
  intakeGrants: number;
  releaseHolds: number;
  chatBindings: number;
  chatPairings: number;
  chatActions: number;
  /** Automatic updates that were on in the backup (turned off until a person turns them on again). */
  autoUpdates: number;
};

/** Every chat button, note and prompt table that can still act: consumed here, by token (`consumed`, or `consumed_at`). */
const CHAT_ACTION_TABLES = ["chat_action", "chat_flow_action", "chat_flow_choice", "chat_flow_note", "chat_question_action", "chat_ask_action", "chat_flow_prompt", "chat_question_prompt"] as const;
const CHAT_DECIDE_TABLES = ["chat_decide_action", "chat_decide_prompt"] as const;
const openChatActions = (store: Store): number =>
  CHAT_ACTION_TABLES.reduce((sum, table) => sum + count(store, `SELECT count(*) AS n FROM ${table} WHERE consumed IS NULL`), 0)
  + CHAT_DECIDE_TABLES.reduce((sum, table) => sum + count(store, `SELECT count(*) AS n FROM ${table} WHERE consumed_at IS NULL`), 0)
  + count(store, "SELECT count(*) AS n FROM chat_note_draft WHERE state IN ('pending', 'armed')");

const count = (store: Store, sql: string): number => Number(store.handle.prepare(sql).get()?.["n"] ?? 0);

function freshRecoveryGeneration(exclude: ReadonlySet<string>): string {
  for (let i = 0; i < 16; i += 1) {
    const candidate = randomBytes(16).toString("hex");
    if (RECOVERY_GENERATION_PATTERN.test(candidate) && !exclude.has(candidate)) return candidate;
  }
  throw new Error("Could not generate a distinct recovery generation");
}

/**
 * Retire all restored credential/session/grant authority and rotate
 * `workspace_identity.recovery_generation` inside an active transaction on the
 * staged restored Store. Throws if any postcondition fails so the transaction
 * rolls back and the live database stays untouched.
 */
export function retireRestoredAuthority(
  store: Store,
  options: { now: Date; actor: string; replacedRecoveryGeneration?: string | null },
): RestoreRetirementSummary {
  const { now, actor } = options;
  const identity = store.workspaceIdentity();
  if (!WORKSPACE_ID_PATTERN.test(identity.id) || !RECOVERY_GENERATION_PATTERN.test(identity.recoveryGeneration)) {
    throw new Error("Restored database has an invalid workspace identity");
  }

  const excluded = new Set<string>([identity.recoveryGeneration]);
  if (typeof options.replacedRecoveryGeneration === "string" && options.replacedRecoveryGeneration !== "") {
    excluded.add(options.replacedRecoveryGeneration);
  }
  const nextGeneration = freshRecoveryGeneration(excluded);

  // 1. Rotate recovery_generation while keeping workspace_id & created_at immutable.
  const rotated = store.handle
    .prepare("UPDATE workspace_identity SET recovery_generation = ? WHERE singleton = 1")
    .run(nextGeneration);
  if (Number(rotated.changes) !== 1) {
    throw new Error("Failed to rotate restored workspace recovery generation");
  }

  // 2. Retire person API tokens via the trusted owner.
  const apiTokens = count(store, "SELECT count(*) AS n FROM credential WHERE kind = 'person' AND revoked_at IS NULL");
  for (const token of store.apiTokens(null)) {
    if (token.revokedAt === null) {
      store.revokeApiToken(token.id, actor, now, "database restored");
    }
  }

  // 3. Retire lead credentials via the trusted owner.
  const leadCredentials = count(store, "SELECT count(*) AS n FROM credential WHERE kind = 'lead' AND revoked_at IS NULL");
  for (const row of store.handle.prepare("SELECT DISTINCT account FROM credential WHERE kind = 'lead' AND revoked_at IS NULL").all()) {
    store.revokeLeadCredentials(String(row["account"]), actor, now);
  }

  // 4. Retire coordinator credentials and sweep pending/confirming proposals.
  const coordinatorCredentials = count(store, "SELECT count(*) AS n FROM credential WHERE kind = 'coordinator' AND revoked_at IS NULL");
  for (const row of store.handle.prepare("SELECT id FROM credential WHERE kind = 'coordinator' AND revoked_at IS NULL").all()) {
    if (!revokeCoordinator(store, String(row["id"]), actor, now).ok) {
      throw new Error("Coordinator credential retirement failed during restore");
    }
  }
  for (const row of store.handle.prepare("SELECT id FROM credential WHERE kind = 'coordinator'").all()) {
    store.sweepCoordinatorProposals(now, String(row["id"]));
  }

  // 5. Retire inbound OAuth codes, refresh tokens, and grants.
  const oauthRows = count(
    store,
    "SELECT (SELECT count(*) FROM oauth_code) + (SELECT count(*) FROM oauth_grant) + (SELECT count(*) FROM oauth_refresh) AS n",
  );
  store.handle.exec("DELETE FROM oauth_code; DELETE FROM oauth_refresh; DELETE FROM oauth_grant");

  // 6. Drop all durable browser sessions.
  const sessions = store.webSessions(null);
  for (const session of sessions) {
    store.dropWebSession(session.idHash);
  }

  // 7. Retire publication grants & intake grants.
  const publicationGrants = count(store, "SELECT count(*) AS n FROM publication_grant WHERE revoked_at IS NULL");
  for (const row of store.handle.prepare("SELECT DISTINCT repo FROM publication_grant WHERE revoked_at IS NULL").all()) {
    if (!store.revokePublicationGrant(String(row["repo"]), actor, now)) {
      throw new Error("Publication grant retirement failed during restore");
    }
  }
  const intakeGrants = count(store, "SELECT count(*) AS n FROM intake_grant WHERE revoked_at IS NULL");
  for (const row of store.handle.prepare("SELECT DISTINCT repo FROM intake_grant WHERE revoked_at IS NULL").all()) {
    if (!store.clearIntakeGrant(String(row["repo"]), actor, now)) {
      throw new Error("Intake grant retirement failed during restore");
    }
  }

  // 8. Place previously auto-publish-allowed tasks on prospective hold.
  const releaseTasks = store.handle
    .prepare("SELECT DISTINCT task_id FROM action_ledger WHERE task_id IS NOT NULL AND action IN (?, ?)")
    .all(PUBLISH_HELD_ACTION, PUBLISH_ALLOWED_ACTION);
  let releaseHolds = 0;
  for (const row of releaseTasks) {
    const taskId = String(row["task_id"]);
    if (autoPublishHeld(store, taskId) === null) {
      holdAutoPublish(store, {
        taskId,
        now,
        why: "Restored publication permission is on hold. This does not establish whether earlier work ran or stopped.",
      });
      releaseHolds += 1;
    }
    if (autoPublishHeld(store, taskId) === null) {
      throw new Error("Release publication hold failed during restore");
    }
  }

  // 9. Retire chat pairings, the codes that make them and every button or prompt a chat could still tap. A binding's
  //    liveness reads the account generation, which a restore does not move: a chat unpaired after the backup would
  //    otherwise act and approve again. Each binding through its trusted owner (ChatCore.revokeBinding).
  const chatBindings = count(store, "SELECT count(*) AS n FROM chat_binding WHERE revoked IS NULL");
  const chatPairings = count(store, "SELECT count(*) AS n FROM chat_pair WHERE consumed IS NULL");
  const chatActions = openChatActions(store);
  const stamp = now.toISOString();
  for (const provider of CHAT_PROVIDERS) {
    const chat = new ChatCore(store, provider);
    for (const row of chat.prepare("SELECT id FROM chat_binding WHERE provider = :provider AND revoked IS NULL").all()) {
      chat.revokeBinding({ id: Number(row["id"]) }, now, actor);
    }
    chat.prepare("UPDATE chat_room SET revoked = ?, revoked_by = ? WHERE provider = :provider AND revoked IS NULL").run(stamp, actor);
  }
  store.handle.prepare("UPDATE chat_pair SET consumed = ? WHERE consumed IS NULL").run(stamp);
  for (const table of CHAT_ACTION_TABLES) store.handle.prepare(`UPDATE ${table} SET consumed = ? WHERE consumed IS NULL`).run(stamp);
  for (const table of CHAT_DECIDE_TABLES) store.handle.prepare(`UPDATE ${table} SET consumed_at = ? WHERE consumed_at IS NULL`).run(stamp);
  store.handle.prepare("UPDATE chat_note_draft SET state = 'discarded' WHERE state IN ('pending', 'armed')").run();

  // 10. A standing yes to install releases by itself: off until a person turns it on again (checked inside).
  const autoUpdates = retireRestoredAutoUpdates(store.handle, actor, stamp);
  if (autoUpdates > 0) store.recordAction({ at: stamp, actor, repo: null, taskId: null, runId: null, action: "automatic updates", outcome: "off", source: "policy", detail: RESTORED_AUTO_UPDATES_OFF });

  // 11. Strict postcondition verification before commit.
  const afterIdentity = store.workspaceIdentity();
  if (afterIdentity.id !== identity.id || afterIdentity.recoveryGeneration !== nextGeneration || excluded.has(afterIdentity.recoveryGeneration)) {
    throw new Error("Restored workspace identity postcondition failed");
  }
  const stillAllowed = store.handle.prepare(`
    SELECT count(*) AS n FROM action_ledger a
    JOIN (
      SELECT max(id) AS id FROM action_ledger
      WHERE task_id IS NOT NULL AND action IN (?, ?)
      GROUP BY task_id
    ) latest ON latest.id = a.id
    WHERE a.action = ?
  `).get(PUBLISH_HELD_ACTION, PUBLISH_ALLOWED_ACTION, PUBLISH_ALLOWED_ACTION);
  if (
    Number(stillAllowed?.["n"] ?? 0) !== 0
    || count(store, "SELECT count(*) AS n FROM credential WHERE revoked_at IS NULL") !== 0
    || count(store, "SELECT count(*) AS n FROM web_session") !== 0
    || count(store, "SELECT (SELECT count(*) FROM oauth_code) + (SELECT count(*) FROM oauth_grant) + (SELECT count(*) FROM oauth_refresh) AS n") !== 0
    || count(store, "SELECT count(*) AS n FROM publication_grant WHERE revoked_at IS NULL") !== 0
    || count(store, "SELECT count(*) AS n FROM intake_grant WHERE revoked_at IS NULL") !== 0
    || count(store, "SELECT count(*) AS n FROM coordinator_proposal WHERE state IN ('pending', 'confirming')") !== 0
    || count(store, "SELECT count(*) AS n FROM chat_binding WHERE revoked IS NULL") !== 0
    || count(store, "SELECT count(*) AS n FROM chat_room WHERE revoked IS NULL") !== 0
    || count(store, "SELECT count(*) AS n FROM chat_pair WHERE consumed IS NULL") !== 0
    || openChatActions(store) !== 0
    || count(store, "SELECT count(*) AS n FROM auto_update_policy WHERE enabled = 1") !== 0
  ) {
    throw new Error("Restored credential retirement postcondition failed");
  }

  return {
    workspaceId: afterIdentity.id,
    previousRecoveryGeneration: identity.recoveryGeneration,
    recoveryGeneration: afterIdentity.recoveryGeneration,
    apiTokens,
    leadCredentials,
    coordinatorCredentials,
    oauthRows,
    webSessions: sessions.length,
    publicationGrants,
    intakeGrants,
    releaseHolds,
    chatBindings,
    chatPairings,
    chatActions,
    autoUpdates,
  };
}
