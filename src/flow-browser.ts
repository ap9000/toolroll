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
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { personProof } from "./person-proof.js";
import { flowDigest, validateFlowDefinition, type FlowDefinition } from "./flows.js";
import type { FlowRow, FlowScriptRow, Store } from "./store.js";

/** v144: each approval of browser use, live or ended. `digest` is browserApprovalDigest of what was approved. Additive only. */
export const FLOW_BROWSER_SCHEMA = `
CREATE TABLE IF NOT EXISTS flow_browser_grant (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  flow          INTEGER NOT NULL,
  repo          TEXT NOT NULL,
  flow_revision INTEGER NOT NULL,
  flow_digest   TEXT NOT NULL,
  digest        TEXT NOT NULL,
  zones_json    TEXT NOT NULL,
  signed_by     TEXT NOT NULL,
  signed_at     TEXT NOT NULL,
  proof         TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_browser_live ON flow_browser_grant (flow) WHERE revoked_at IS NULL;
`;

/** One zone an approval covers: the zone, and the script it runs (name, version and content digest). */
export type BrowserZone = { zone: string; script: string; version: number; digest: string };
/** Everything an approval is about: the flow, its project, the drawing (revision and digest) and every browser zone. */
export type BrowserTerms = { flow: number; repo: string; revision: number; flowDigest: string; zones: BrowserZone[] };
export type FlowBrowserGrant = BrowserTerms & { id: number; digest: string; signedBy: string; signedAt: string; proof: string };

function definitionOf(flow: FlowRow): FlowDefinition | null {
  try { return validateFlowDefinition(JSON.parse(flow.definitionJson), { stored: true }); } catch { return null; }
}

/** The approval's digest: domain-separated over the whole of its terms, so a changed flow, drawing, revision or any
 * covered script (a restored one is a new version) is a different approval. */
export function browserApprovalDigest(terms: BrowserTerms): string {
  return createHash("sha256").update(`toolroll:flow-browser:${canonicalJson(terms)}`, "utf8").digest("hex").slice(0, 32);
}

/** The flow's script zones that say they start a browser, each with the script it runs now; null when one's script is
 * missing, waiting for approval, or runs a project file (an approval seals the script's own text, never a file the
 * project can change). */
export function browserZonesOf(store: Store, flow: FlowRow, definition: FlowDefinition): BrowserZone[] | null {
  const out: BrowserZone[] = [];
  for (const stage of definition.stages) {
    if (stage.kind !== "check" || stage.browser !== true) continue;
    const script = stage.script === null ? null : store.flowScript(flow.repo, stage.script);
    if (script === null || script.held !== null || script.file !== null) return null;
    out.push({ zone: stage.id, script: script.name, version: script.version, digest: script.digest });
  }
  return out;
}

/** What an approval of this flow would be about now, read from the store; null when it can't be approved. */
export function browserTermsOf(store: Store, flow: FlowRow): BrowserTerms | null {
  const definition = definitionOf(flow);
  const zones = definition === null ? null : browserZonesOf(store, flow, definition);
  return definition === null || zones === null ? null : { flow: flow.id, repo: flow.repo, revision: flow.revision, flowDigest: flowDigest(definition), zones };
}

function readGrant(row: Record<string, unknown> | undefined): FlowBrowserGrant | null {
  if (row === undefined) return null;
  let zones: unknown;
  try { zones = JSON.parse(String(row["zones_json"])); } catch { return null; }
  if (!Array.isArray(zones) || !zones.every(one => one !== null && typeof one === "object" && typeof one.zone === "string" && typeof one.script === "string" && Number.isInteger(one.version) && typeof one.digest === "string")) return null;
  return { id: Number(row["id"]), flow: Number(row["flow"]), repo: String(row["repo"]), revision: Number(row["flow_revision"]), flowDigest: String(row["flow_digest"]), digest: String(row["digest"]),
    zones: zones as BrowserZone[], signedBy: String(row["signed_by"]), signedAt: String(row["signed_at"]), proof: String(row["proof"]) };
}

/** The flow's live approval, as recorded (whether it still stands is browserStanding's question). */
export function liveBrowserGrant(store: Store, flowId: number): FlowBrowserGrant | null {
  return readGrant(store.handle.prepare("SELECT * FROM flow_browser_grant WHERE flow = ? AND revoked_at IS NULL").get(flowId));
}

/** Whether `name` may approve on `repo` now: a live approver account that reaches the project. */
function approverNow(store: Store, name: string, repo: string): boolean {
  const account = store.accountOf(name);
  return account !== null && account.revokedAt === null && account.role === "approver" && store.accountCanAccess(name, repo);
}

/**
 * Whether `zone` of this flow may start a browser now. `run`, when given, is what the caller is about to run — the
 * drawing it read and the very script object it hands the launch — and the answer is about exactly that. The live
 * approval stands only when its digest is the approval this flow would be now (same flow, project, drawing revision and
 * digest, and every browser zone's script name, version and digest), it was a person's, and its signer is still an
 * approver who reaches the project; `run`'s drawing must be that drawing and its script that zone's script. Anything
 * unreadable, changed or mismatched is a no, with the plain words a card waits with.
 */
export function browserStanding(store: Store, flowId: number, zone: string, run?: { definition: FlowDefinition; script: FlowScriptRow }): { allowed: true } | { allowed: false; said: string } {
  const flow = store.getFlow(flowId);
  const definition = flow === null ? null : definitionOf(flow);
  const stage = definition?.stages.find(one => one.id === zone);
  if (flow === null || definition === null || stage === undefined || stage.kind !== "check" || stage.browser !== true) return { allowed: false, said: "This zone doesn't say it starts a browser." };
  const approve = `Approve it with: toolroll flows browser ${flow.id} on`;
  const grant = liveBrowserGrant(store, flow.id);
  if (grant === null) return { allowed: false, said: `${stage.title} starts a browser, and no one has approved browser use for the ${flow.name} flow, so it didn't run. ${approve}` };
  const terms = browserTermsOf(store, flow);
  const now = terms?.zones.find(one => one.zone === zone);
  const runStage = run?.definition.stages.find(one => one.id === zone);
  const runs = run === undefined || (terms !== null && now !== undefined && flowDigest(run.definition) === terms.flowDigest && runStage?.kind === "check" && runStage.browser === true
    && runStage.script === run.script.name && run.script.repo === flow.repo && run.script.held === null && run.script.file === null
    && run.script.name === now.script && run.script.version === now.version && run.script.digest === now.digest);
  const stands = runs && terms !== null && now !== undefined && flow.state === "active" && grant.digest === browserApprovalDigest(terms)
    && browserApprovalDigest({ flow: grant.flow, repo: grant.repo, revision: grant.revision, flowDigest: grant.flowDigest, zones: grant.zones }) === grant.digest
    && personProof(grant.proof) && approverNow(store, grant.signedBy, flow.repo);
  return stands ? { allowed: true } : { allowed: false, said: `${stage.title} starts a browser, but browser use was approved for an earlier version of the ${flow.name} flow or its scripts, so it didn't run. ${approve}` };
}

/** What approving means, in words the person reads before they give their password. */
export function browserTerms(zones: readonly BrowserZone[]): string[] {
  return [
    `Lets ${zones.map(one => `the ${one.script} script (zone ${one.zone})`).join(", ")} start Playwright's Chromium headless shell inside the flow's sandbox: the same one macOS service a project check gets for it, and nothing else.`,
    "Changing the flow or one of these scripts (even back to how it was) ends it; nothing else gets it.",
  ];
}

/**
 * Approve browser use for the flow as it stands. `proof` is the signer's credential method, proved by the caller just
 * now; only a person's counts (a lead's or remote run's token is refused), from an approver who reaches the project.
 * Re-reads the flow, its zones and scripts in the one transaction that writes, and `sawDigest`, when given, is the
 * approval (browserApprovalDigest: drawing and scripts) the person read. Replaces any live one.
 */
export function signFlowBrowser(store: Store, input: { flow: number; signer: string; proof: string | null; sawDigest?: string }, now: Date): { ok: true; grant: FlowBrowserGrant } | { ok: false; message: string } {
  if (!personProof(input.proof)) return { ok: false, message: "Browser use needs a person's own approval: sign in with your password (a lead's or remote run's token can't give it)." };
  return store.transact(() => {
    const flow = store.getFlow(input.flow);
    if (flow === null || flow.state !== "active") return { ok: false as const, message: "No such flow." };
    if (!approverNow(store, input.signer, flow.repo)) return { ok: false as const, message: "Only an approver on this flow's project can approve browser use." };
    if (definitionOf(flow) === null) return { ok: false as const, message: "This flow's drawing can't be read." };
    const terms = browserTermsOf(store, flow);
    if (terms === null) return { ok: false as const, message: "A zone that starts a browser has no script it can approve: missing, waiting for approval, or one that runs a project file (write the script on the zone instead)." };
    if (terms.zones.length === 0) return { ok: false as const, message: `No zone in ${flow.name} says it starts a browser. Mark the script zone first (browser: true), then approve.` };
    const digest = browserApprovalDigest(terms);
    if (input.sawDigest !== undefined && input.sawDigest !== digest) return { ok: false as const, message: "This flow or its scripts changed while you were reading. Read the terms again." };
    store.handle.prepare("UPDATE flow_browser_grant SET revoked_at = ?, revoked_by = ? WHERE flow = ? AND revoked_at IS NULL").run(now.toISOString(), input.signer, flow.id);
    const id = Number(store.handle.prepare("INSERT INTO flow_browser_grant (flow, repo, flow_revision, flow_digest, digest, zones_json, signed_by, signed_at, proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(flow.id, flow.repo, terms.revision, terms.flowDigest, digest, JSON.stringify(terms.zones), input.signer, now.toISOString(), input.proof!).lastInsertRowid);
    store.recordAction({ at: now.toISOString(), actor: input.signer, repo: flow.repo, taskId: null, runId: null, source: "policy", action: "flow browser use: approved", outcome: "signed",
      detail: `${flow.name} (flow #${flow.id}) · ${terms.zones.map(one => `${one.zone}: ${one.script} v${one.version}`).join(", ")}` });
    return { ok: true as const, grant: { ...terms, id, digest, signedBy: input.signer, signedAt: now.toISOString(), proof: input.proof! } };
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
