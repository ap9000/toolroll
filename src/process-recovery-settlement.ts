import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { currentBootId } from "./boot-identity.js";
import { assessDarwinCoalitionRecovery } from "./process-recovery-coalition.js";
import { preparedCandidateObserverGapEligibility } from "./process-recovery-eligibility.js";
import { collectLegacySourceProvenance, collectedLegacyProvenanceOf } from "./process-recovery-provenance.js";
import type { Store } from "./store.js";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A one-shot legacy repair, never a force-clear API. It recollects its own
 * pinned historical and current OS facts. Serialized successful reports are
 * deliberately not inputs. Inspection is the default and never writes custody.
 * The caller opens the compatible Store; this function never migrates it. */
export async function recoverPreparedObserverGap(store: Store, input: {
  profilePath: string; compilationDirectory: string; evidenceRoot: string;
  mode: "inspect" | "record";
}) {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (input.mode !== "inspect" && input.mode !== "record") return refuse("invalid-recovery-mode");
  const collected = await collectLegacySourceProvenance(store.handle, input);
  // The collector exposes only fixed diagnostic codes. Preserve the failed
  // phase so an operator can distinguish an unreadable anchor from a later
  // source or service observation without exposing subprocess output.
  if (!collected.ok) return collected;
  const live = collectedLegacyProvenanceOf(collected.proof);
  if (!live) return refuse("uncollected-process-evidence");
  const { receipt, snapshot, anchor } = live;
  const now = new Date();
  const context = { runId: receipt.targetRun, evidenceRoot: input.evidenceRoot, now,
    host: hostname(), bootId: currentBootId() };
  let matchingRoot = false;
  try { matchingRoot = realpathSync(input.evidenceRoot) === join(dirname(anchor.databasePath), "evidence"); } catch { /* Refuse an unreadable evidence root. */ }
  if (context.host !== receipt.host || context.bootId !== receipt.bootId || !matchingRoot ||
      ![snapshot.startedAt, snapshot.finishedAt].every(value => Number.isFinite(Date.parse(value))) || Date.parse(snapshot.finishedAt) > now.getTime() ||
      Date.parse(snapshot.startedAt) > Date.parse(snapshot.finishedAt)) return refuse("recovery-context-changed");
  const eligible = preparedCandidateObserverGapEligibility(store, context);
  if (!eligible.ok) return refuse(eligible.reason);
  if (eligible.binding.run.head !== receipt.head || eligible.binding.scope.digest !== receipt.scopeDigest ||
      Date.parse(snapshot.startedAt) <= Date.parse(eligible.binding.run.finishedAt!) ||
      snapshot.nativeSourceSha256 !== anchor.nativeSourceSha256 || snapshot.nativeExecutableSha256 !== anchor.nativeExecutableSha256 ||
      sha256(JSON.stringify(snapshot)) !== receipt.snapshotDigest) return refuse("recovery-source-mismatch");
  const assessed = assessDarwinCoalitionRecovery({ host: context.host, bootId: receipt.bootId,
    resourceCoalitionId: receipt.resourceCoalitionId, sourceRoot: receipt.sourceRoot,
    preRunUpperBound: receipt.preRunUpperBound, snapshot, preexistingAppServices: receipt.preexistingAppServices });
  if (!assessed.ok) return refuse("surviving-processes-not-excluded");
  const certificate = { schema: 1, kind: "prepared-observer-gap-absence", collectedAt: now.toISOString(),
    eligibility: eligible, provenance: receipt, anchor, inventory: snapshot, assessment: assessed,
    statement: "Positive current absence of direct and ordinary-fork descendants under the recorded audited first-party path and trusted execution assumptions. This observation alone is not a database settlement; a matching committed action-ledger entry records application." };
  const bytes = Buffer.from(JSON.stringify(certificate) + "\n"), digest = sha256(bytes);
  const result = { runId: receipt.targetRun, witnessIds: [...eligible.binding.unknownWitnessIds],
    certificateDigest: digest, observedAt: snapshot.finishedAt, assumptions: receipt.assumptions };
  if (input.mode === "inspect") return { ok: true as const, recorded: false as const, ...result };

  // Preserve the entire pre-mutation row inventory and OS observations first.
  // Exclusive, owned files remain as observations if a later transaction fails.
  const directory = join(dirname(anchor.databasePath), "process-recovery");
  let certificatePath: string;
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return refuse("recovery-audit-unavailable");
  }
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || realpathSync(directory) !== directory) return refuse("recovery-audit-unavailable");
    certificatePath = join(directory, digest + ".json");
    const fd = openSync(certificatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch { return refuse("recovery-audit-unavailable"); }

  try {
    return store.transact(() => store.savepoint(() => {
      if (hostname() !== context.host || currentBootId() !== context.bootId) throw Error("recovery-context-changed");
      const current = preparedCandidateObserverGapEligibility(store, { ...context, now: new Date() });
      if (!current.ok || current.digest !== eligible.digest) throw Error("recovery-custody-changed");
      const fd = openSync(certificatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || sha256(readFileSync(fd)) !== digest) throw Error("recovery-audit-changed");
      } finally { closeSync(fd); }
      for (const row of current.binding.witnesses.filter(row => current.binding.unknownWitnessIds.includes(row.id))) {
        const update = store.handle.prepare(`UPDATE run_process SET exited_at = ?
          WHERE id = ? AND run = ? AND pid IS ? AND host = ? AND process_group = ?
            AND observed_at = ? AND exited_at IS NULL AND boot_id IS ? AND containment IS ?
            AND container IS ? AND container_identity IS ? AND container_empty_at IS ?`)
          .run(snapshot.finishedAt, row.id, row.run, row.pid, row.host, row.process_group, row.observed_at,
            row.boot_id, row.containment, row.container, row.container_identity, row.container_empty_at);
        if (Number(update.changes) !== 1) throw Error("recovery-custody-changed");
      }
      if (store.stopQuiescenceProblem(receipt.targetRun) !== null) throw Error("run-still-not-quiescent");
      const actionId = store.recordAction({ at: new Date().toISOString(), actor: "system", repo: current.binding.run.repo,
        taskId: current.binding.run.taskId, runId: receipt.targetRun, action: "process absence recovered",
        outcome: digest, source: "work" });
      store.compactRunProcesses(new Date(), receipt.targetRun);
      return { ok: true as const, recorded: true as const, ...result, actionId, certificatePath };
    }));
  } catch {
    return refuse("recovery-not-recorded");
  }
}
