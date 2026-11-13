/**
 * Settings → Advanced (the eight plan, W4 v2/v3): one switch per person, "Show advanced features". Off, that person's
 * pages leave out the entry points to everything outside the main loop (task, approve, Ready, Complete or send back).
 * Nothing else changes: every route, CLI command and chat proposal works as before, and Settings → Advanced always
 * lists every advanced page, so each is one click away.
 *
 * What a person sees is decided by their own row only (store.ts view_preference): never by what exists elsewhere, so
 * navigation can't say anything about another project. No row: off, except on the demo. Upgrades keep what people had:
 * the v160 migration wrote an ON row for every account present then (advanced-schema.ts). A failed read shows
 * everything (never hide on a doubt).
 *
 * Never hidden, whatever the switch: anything waiting on a person, approval terms, failures and hold reasons, and the
 * current state and off switch of every active safety setting (Passwordless on, provider sign-in set up, an active
 * operating mode, automatic release approval, a fallback chain, commands in the live view, local mode, API tokens and
 * browser sessions). Those surfaces read their own facts, never this switch, or keep their row when the setting is on.
 */
import { currentLocalOwner, localOwnerInFlight, localOwnerStandsNow } from "./local-owner.js";
import { isOpen, policyParts, readPolicy } from "./policy.js";
import { machineActing } from "./scope.js";
import { advancedPreferenceOf, writeAdvancedPreference, type Store } from "./store.js";

/** Whether this person's pages show the advanced entry points: their own row, else on for the demo and off otherwise.
 * Any read failure shows them. */
export function advancedShownFor(store: Pick<Store, "handle" | "isDemo">, account: string | null): boolean {
  try {
    const own = account === null ? null : advancedPreferenceOf(store as Store, account);
    return own ?? store.isDemo();
  } catch {
    return true;
  }
}

/** Who is changing the switch: a browser session's person (re-proved in the write), or the local owner in exactly the
 * `view-preference` act. The account is always the session's own; nothing posted names it. */
export type AdvancedDoor =
  | { kind: "person"; actor: string; generation: number; live: () => boolean }
  | { kind: "local-owner"; actor: string };
export type AdvancedWrite = { ok: true; on: boolean } | { ok: false; problem: string };

const LAPSED = "Your sign-in changed. Sign in again, then change this.";

/** Turn this person's advanced features on or off. The proof and the write are one transaction. */
export function setAdvancedPreference(store: Store, door: AdvancedDoor, on: boolean, now: Date): AdvancedWrite {
  // The store's own write-time check refuses a local owner whose standing lapsed by throwing: nothing was written.
  try { return proveAndWrite(store, door, on, now); } catch (error) { return { ok: false, problem: error instanceof Error ? error.message : LAPSED }; }
}
function proveAndWrite(store: Store, door: AdvancedDoor, on: boolean, now: Date): AdvancedWrite {
  return store.transact((): AdvancedWrite => {
    // An agent's own process (the lead, a remote run) never changes a person's view.
    if (machineActing() || process.env["TOOLROLL_LEAD_TOKEN"] !== undefined) return { ok: false, problem: LAPSED };
    const local = currentLocalOwner();
    if (door.kind === "local-owner") {
      if (local === null || !localOwnerInFlight(local) || local.act !== "view-preference" || local.account !== door.actor || !localOwnerStandsNow(store, local)) return { ok: false, problem: LAPSED };
    } else {
      // A local owner's chain only ever takes its own door.
      if (local !== null) return { ok: false, problem: LAPSED };
      const account = store.accountOf(door.actor);
      if (account === null || account.revokedAt !== null || account.generation !== door.generation || !door.live()) return { ok: false, problem: LAPSED };
    }
    if (!writeAdvancedPreference(store, door.actor, on, now)) return { ok: false, problem: LAPSED };
    store.recordAction({ at: now.toISOString(), actor: door.actor, repo: null, taskId: null, runId: null, action: "advanced features", outcome: on ? "shown" : "hidden", source: "request", detail: door.kind === "local-owner" ? "local owner" : "browser" });
    return { ok: true, on };
  });
}

/**
 * The organisation policy in words when any restriction applies (a provider, model or tool list, or a permission
 * ceiling below escalated), else null. Settings → Advanced off keeps Policy's link while this is non-null. A saved row
 * that doesn't read cleanly, or a read that fails, counts as applying (never hide on a doubt).
 */
export function policyInForce(store: Pick<Store, "handle">): string | null {
  const unsure = "Limits apply: open Policy to see them";
  try {
    const row = store.handle.prepare("SELECT providers_json, models_json, tools_json, ceiling FROM org_policy WHERE id = 1").get();
    if (row === undefined) return null;
    const policy = readPolicy(store.handle);
    const raw = row["providers_json"] !== null || row["models_json"] !== null || row["tools_json"] !== null || row["ceiling"] !== "escalated";
    if (isOpen(policy)) return raw ? unsure : null;
    const parts = policyParts(policy);
    return `Providers: ${parts.providers} · models: ${parts.models} · tools: ${parts.tools} · ceiling: ${parts.ceiling}`;
  } catch {
    return unsure;
  }
}
