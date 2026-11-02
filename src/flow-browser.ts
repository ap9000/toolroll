/**
 * Browser use in a flow's script zone: a per-flow approval a person gives with their own proof, so that zone's launch
 * gets the one sandbox rule a project check gets for Chromium (sandbox-runtime.ts SEATBELT_CHROMIUM) and nothing more.
 *
 * Two halves, both needed. The flow's drawing says which "Run a script" zones start a browser (`browser: true`, part of
 * the flow's digest and said when the flow is confirmed); anyone who may change the flow can say it. Then a person, with
 * their password or sign-in (never a lead's or remote run's token: person-proof.ts), approves browser use for the flow
 * as it stands. The approval seals the flow's digest and, for each browser zone, its script's name and content digest.
 * At launch (flow-steps.ts) the zone gets the rule only while all of that still holds: the same drawing, the same
 * scripts, a person's proof, a signer who still reaches the project. Anything else gets nothing, and the card waits with
 * a plain line naming the missing approval instead of Chromium crashing in the sandbox. Builds, checks, tool servers and
 * every other flow launch (setup, triggers, zones that don't say browser) are untouched.
 */
import { personProof } from "./person-proof.js";
import { flowDigest, validateFlowDefinition, type FlowDefinition } from "./flows.js";
import type { FlowRow, Store } from "./store.js";

/** v144: each approval of browser use, live or ended. Additive only. */
export const FLOW_BROWSER_SCHEMA = `
CREATE TABLE IF NOT EXISTS flow_browser_grant (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  flow        INTEGER NOT NULL,
  repo        TEXT NOT NULL,
  digest      TEXT NOT NULL,
  zones_json  TEXT NOT NULL,
  signed_by   TEXT NOT NULL,
  signed_at   TEXT NOT NULL,
  proof       TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_browser_live ON flow_browser_grant (flow) WHERE revoked_at IS NULL;
`;

/** One zone an approval covers: the zone, and the script it ran when approved (name and content digest). */
export type BrowserZone = { zone: string; script: string; digest: string };
export type FlowBrowserGrant = { id: number; flow: number; repo: string; digest: string; zones: BrowserZone[]; signedBy: string; signedAt: string; proof: string };

function definitionOf(flow: FlowRow): FlowDefinition | null {
  try { return validateFlowDefinition(JSON.parse(flow.definitionJson), { stored: true }); } catch { return null; }
}

/** The flow's script zones that say they start a browser, each with the script it runs now; null when a script is
 * missing or waiting for approval (nothing can be approved then). */
export function browserZonesOf(store: Store, flow: FlowRow, definition: FlowDefinition): BrowserZone[] | null {
  const out: BrowserZone[] = [];
  for (const stage of definition.stages) {
    if (stage.kind !== "check" || stage.browser !== true) continue;
    const script = stage.script === null ? null : store.flowScript(flow.repo, stage.script);
    if (script === null || script.held !== null) return null;
    out.push({ zone: stage.id, script: script.name, digest: script.digest });
  }
  return out;
}

function readGrant(row: Record<string, unknown> | undefined): FlowBrowserGrant | null {
  if (row === undefined) return null;
  let zones: unknown;
  try { zones = JSON.parse(String(row["zones_json"])); } catch { return null; }
  if (!Array.isArray(zones) || !zones.every(one => one !== null && typeof one === "object" && typeof one.zone === "string" && typeof one.script === "string" && typeof one.digest === "string")) return null;
  return { id: Number(row["id"]), flow: Number(row["flow"]), repo: String(row["repo"]), digest: String(row["digest"]), zones: zones as BrowserZone[],
    signedBy: String(row["signed_by"]), signedAt: String(row["signed_at"]), proof: String(row["proof"]) };
}

/** The flow's live approval, as recorded (whether it still stands is browserStanding's question). */
export function liveBrowserGrant(store: Store, flowId: number): FlowBrowserGrant | null {
  return readGrant(store.handle.prepare("SELECT * FROM flow_browser_grant WHERE flow = ? AND revoked_at IS NULL").get(flowId));
}

/**
 * Whether `zone` of this flow may start a browser now: it says so in the drawing, and a live approval covers this very
 * drawing and the zone's script as it is now, given on a person's proof by someone who still reaches the project.
 * `allowed` false carries the plain words a card waits with. Read at the moment of use; anything unreadable is a no.
 */
export function browserStanding(store: Store, flowId: number, zone: string): { allowed: true } | { allowed: false; said: string } {
  const flow = store.getFlow(flowId);
  const definition = flow === null ? null : definitionOf(flow);
  const stage = definition?.stages.find(one => one.id === zone);
  if (flow === null || definition === null || stage === undefined || stage.kind !== "check" || stage.browser !== true) return { allowed: false, said: "This zone doesn't say it starts a browser." };
  const approve = `Approve it with: toolroll flows browser ${flow.id} on`;
  const grant = liveBrowserGrant(store, flow.id);
  if (grant === null) return { allowed: false, said: `${stage.title} starts a browser, and no one has approved browser use for the ${flow.name} flow, so it didn't run. ${approve}` };
  const scripts = browserZonesOf(store, flow, definition);
  const covered = grant.zones.find(one => one.zone === zone);
  const now = scripts?.find(one => one.zone === zone);
  const stands = flow.state === "active" && grant.repo === flow.repo && grant.digest === flowDigest(definition) && personProof(grant.proof)
    && store.accountCanAccess(grant.signedBy, flow.repo) && covered !== undefined && now !== undefined && covered.script === now.script && covered.digest === now.digest;
  return stands ? { allowed: true } : { allowed: false, said: `${stage.title} starts a browser, but browser use was approved for an earlier version of the ${flow.name} flow or its script, so it didn't run. ${approve}` };
}

/** What approving means, in words the person reads before they give their password. */
export function browserTerms(zones: readonly BrowserZone[]): string[] {
  return [
    `Lets ${zones.map(one => `the ${one.script} script (zone ${one.zone})`).join(", ")} start Playwright's Chromium headless shell inside the flow's sandbox: the same one macOS service a project check gets for it, and nothing else.`,
    "Changing the flow or one of these scripts ends it; nothing else gets it.",
  ];
}

/**
 * Approve browser use for the flow as it stands. `proof` is the signer's credential method, proved by the caller just
 * now; only a person's counts (a lead's or remote run's token is refused). Re-reads the flow, its zones and scripts in
 * the one transaction that writes, and `sawDigest`, when given, is the drawing the person read. Replaces any live one.
 */
export function signFlowBrowser(store: Store, input: { flow: number; signer: string; proof: string | null; sawDigest?: string }, now: Date): { ok: true; grant: FlowBrowserGrant } | { ok: false; message: string } {
  if (!personProof(input.proof)) return { ok: false, message: "Browser use needs a person's own approval: sign in with your password (a lead's or remote run's token can't give it)." };
  return store.transact(() => {
    const flow = store.getFlow(input.flow);
    if (flow === null || flow.state !== "active") return { ok: false as const, message: "No such flow." };
    if (!store.accountCanAccess(input.signer, flow.repo)) return { ok: false as const, message: "You can't reach this flow's project." };
    const definition = definitionOf(flow);
    if (definition === null) return { ok: false as const, message: "This flow's drawing can't be read." };
    const digest = flowDigest(definition);
    if (input.sawDigest !== undefined && input.sawDigest !== digest) return { ok: false as const, message: "This flow changed while you were reading. Read the terms again." };
    const zones = browserZonesOf(store, flow, definition);
    if (zones === null) return { ok: false as const, message: "A zone that starts a browser has no script that can run yet (missing, or waiting for approval)." };
    if (zones.length === 0) return { ok: false as const, message: `No zone in ${flow.name} says it starts a browser. Mark the script zone first (browser: true), then approve.` };
    store.handle.prepare("UPDATE flow_browser_grant SET revoked_at = ?, revoked_by = ? WHERE flow = ? AND revoked_at IS NULL").run(now.toISOString(), input.signer, flow.id);
    const id = Number(store.handle.prepare("INSERT INTO flow_browser_grant (flow, repo, digest, zones_json, signed_by, signed_at, proof) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(flow.id, flow.repo, digest, JSON.stringify(zones), input.signer, now.toISOString(), input.proof!).lastInsertRowid);
    store.recordAction({ at: now.toISOString(), actor: input.signer, repo: flow.repo, taskId: null, runId: null, source: "policy", action: "flow browser use: approved", outcome: "signed",
      detail: `${flow.name} (flow #${flow.id}) · ${zones.map(one => `${one.zone}: ${one.script}`).join(", ")}` });
    return { ok: true as const, grant: { id, flow: flow.id, repo: flow.repo, digest, zones, signedBy: input.signer, signedAt: now.toISOString(), proof: input.proof! } };
  });
}

/** Any approver on the project ends it, with no password: lowering authority. False when there was none. */
export function revokeFlowBrowser(store: Store, flowId: number, by: string, now: Date): boolean {
  return store.transact(() => {
    const flow = store.getFlow(flowId);
    const ended = store.handle.prepare("UPDATE flow_browser_grant SET revoked_at = ?, revoked_by = ? WHERE flow = ? AND revoked_at IS NULL").run(now.toISOString(), by, flowId).changes > 0;
    if (ended) store.recordAction({ at: now.toISOString(), actor: by, repo: flow?.repo ?? null, taskId: null, runId: null, source: "policy", action: "flow browser use: revoked", outcome: "revoked", detail: `flow #${flowId}` });
    return ended;
  });
}
