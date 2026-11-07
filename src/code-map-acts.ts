/**
 * Who may change the code map (docs/plans/code-map.md §5). Turning it on or off is a person's, proved inside the write,
 * or this computer's local owner in exactly that act. Ending the holdout is a person's and never a local owner's:
 * `personProof("local-owner")` is true, so the write refuses that basis by name. Lead and remote tokens never act here.
 */
import { currentLocalOwner, localOwnerInFlight, localOwnerStandsNow } from "./local-owner.js";
import { personProof } from "./person-proof.js";
import { machineActing } from "./scope.js";
import type { Store } from "./store.js";

export type MapPerson = { actor: string; generation: number; method: string; live?: () => boolean };
export type MapDoor = { kind: "person"; person: MapPerson } | { kind: "local-owner"; actor: string };
export type MapActResult = { ok: true } | { ok: false; problem: string };

const NOT_YOURS = "Only a person with approver rank on this project can change this. A lead or remote token can't.";

function personStands(store: Store, person: MapPerson, repo: string): boolean {
  if (machineActing() || process.env["TOOLROLL_LEAD_TOKEN"] !== undefined) return false;
  if (person.method === "lead-token" || person.method === "remote-token" || !personProof(person.method)) return false;
  const account = store.accountOf(person.actor);
  return account !== null && account.revokedAt === null && account.role === "approver" && account.generation === person.generation && store.accountCanAccess(person.actor, repo) && (person.live?.() ?? true);
}

/** Turn the map on or off. The proof is checked in the write's own transaction. */
export function setCodeMapSwitch(store: Store, door: MapDoor, repo: string, on: boolean, now: Date): MapActResult {
  return store.transact(() => {
    let actor: string;
    if (door.kind === "local-owner") {
      const local = currentLocalOwner();
      if (local === null || !localOwnerInFlight(local) || local.act !== "code-map-switch" || local.account !== door.actor || !localOwnerStandsNow(store, local)) return { ok: false, problem: NOT_YOURS };
      actor = door.actor;
    } else {
      if (!personStands(store, door.person, repo)) return { ok: false, problem: NOT_YOURS };
      actor = door.person.actor;
    }
    const changed = store.handle.prepare("UPDATE project SET code_map = ? WHERE path = ?").run(on ? 1 : 0, repo);
    if (Number(changed.changes) !== 1) return { ok: false, problem: "That project isn't one Toolroll has." };
    store.recordAction({ at: now.toISOString(), actor, repo, taskId: null, runId: null, action: "code map switched", outcome: on ? "on" : "off", source: "request", detail: door.kind === "local-owner" ? "local owner" : door.person.method });
    return { ok: true };
  });
}

/** End the holdout early: enrollment stops; families keep their arms. */
export function endHoldout(store: Store, door: MapDoor, repo: string, now: Date): MapActResult {
  return store.transact(() => {
    if (door.kind === "local-owner" || currentLocalOwner() !== null) return { ok: false, problem: "Ending the holdout takes a person's own sign-in." };
    if (door.person.method === "local-owner" || !personStands(store, door.person, repo)) return { ok: false, problem: NOT_YOURS };
    const changed = store.handle.prepare("UPDATE project SET code_map_enroll_until = ? WHERE path = ?").run(now.toISOString(), repo);
    if (Number(changed.changes) !== 1) return { ok: false, problem: "That project isn't one Toolroll has." };
    store.recordAction({ at: now.toISOString(), actor: door.person.actor, repo, taskId: null, runId: null, action: "code map holdout ended", outcome: "ended", source: "request", detail: door.person.method });
    return { ok: true };
  });
}
