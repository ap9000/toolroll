/**
 * The paired phone's authorization boundary (reads.ts), against a real console (createDecisionServer): what a phone can
 * see is exactly what its account can see on the web, refusals look the same whether the thing is hidden or missing,
 * standing is proved before and after every read, spend never leaves the Mac, and a watch that loses sight of its run
 * ends as denied with nothing more sent.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { addApprover } from "../scope.js";
import { createDecisionServer, phoneReadsOf } from "../serve.js";
import { openStore, type Store } from "../store.js";
import type { CompanionReadHandlers, PairedDevicePrincipal } from "./daemon.js";
import { activatePendingDevice, revokePairedDeviceRecord, savePendingDevice } from "./store.js";

const T0 = new Date("2026-11-27T10:00:00.000Z");
let store: Store, server: Server, evidenceRoot: string, repo: string, hidden: string, reads: CompanionReadHandlers;
let principal: PairedDevicePrincipal;
let visibleRun: number, hiddenRun: number;

const place = (id: string, where: string): string => {
  store.createTask({ id, title: `Work ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours");
  store.placeTask(ref.id, where);
  return ref.id;
};
const runOf = (refId: string, lease: string): number => store.startRun({ taskRef: refId, leaseId: lease, runner: "r", branch: "x", worktree: "/w", now: T0,
  route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });

/** A read's refusal as the phone sees it: its code and message. */
async function refusal(work: () => unknown): Promise<{ code: string; message: string }> {
  try { await work(); } catch (error) { return { code: String((error as { code?: unknown }).code), message: (error as Error).message }; }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  store = openStore(":memory:");
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-reads-ev-"));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "so-reads-repo-")));
  hidden = realpathSync(mkdtempSync(join(tmpdir(), "so-reads-hidden-")));
  for (const one of [repo, hidden]) execFileSync("git", ["init", "-q", one]);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap failed");
  const bea = addApprover(store, "bea", T0, { name: "alex", token: alex.token });
  if (!bea.ok) throw new Error("bea");
  server = createDecisionServer({ store, evidenceRoot, repos: [repo, hidden], clock: () => new Date() });
  reads = phoneReadsOf(server)!;
  visibleRun = runOf(place("t-mine", repo), "a");
  hiddenRun = runOf(place("t-hidden", hidden), "b");
  // bea may use one project only (set before pairing: an access change retires the account's phones).
  expect(store.setAccountProjects("bea", [repo], "alex", T0)).toEqual({ ok: true });
  const identity = store.workspaceIdentity();
  savePendingDevice(store.handle, { deviceId: "dev_bea", accountName: "bea", deviceName: "Bea's iPhone", phoneStaticPub: Buffer.alloc(32, 1), deviceRelayPub: Buffer.alloc(32, 2),
    devicePsk: Buffer.alloc(32, 3), recoveryGeneration: identity.recoveryGeneration, accountGeneration: store.accountOf("bea")!.generation, createdAt: new Date().toISOString() });
  expect(activatePendingDevice(store, "dev_bea", new Date())).toBe("activated");
  principal = { kind: "paired-device", deviceId: "dev_bea", accountName: "bea", workspaceId: identity.id, recoveryGeneration: identity.recoveryGeneration, requestFromThisComputer: false };
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of [evidenceRoot, repo, hidden]) rmSync(dir, { recursive: true, force: true });
});

describe("the phone's reads, as its account", () => {
  test("a project the account isn't admitted to answers exactly like a task or run that doesn't exist", async () => {
    const missingTask = await refusal(() => reads.taskSteps(principal, { task: "t-nowhere" }));
    expect(missingTask).toEqual({ code: "not_found", message: "No such task." });
    expect(await refusal(() => reads.taskSteps(principal, { task: "t-hidden" }))).toEqual(missingTask);
    expect(await refusal(() => reads.taskDiff(principal, { task: "t-hidden" }))).toEqual(missingTask);
    expect(await refusal(() => reads.taskApprovalRead(principal, { task: "t-hidden" }))).toEqual(missingTask);
    const missingRun = await refusal(() => reads.runWindowRead(principal, { run: "999999" }));
    expect(missingRun).toEqual({ code: "not_found", message: "No such run." });
    expect(await refusal(() => reads.runWindowRead(principal, { run: String(hiddenRun) }))).toEqual(missingRun);
    expect(reads.runWatchSubscribe!(principal, { run: String(hiddenRun) }, () => {}, () => {})).toEqual({ ok: false, code: "not_found", message: "No such run." });
    // Its own project reads fine.
    expect(await reads.taskSteps(principal, { task: "t-mine" })).toBeTruthy();
    expect(await reads.runWindowRead(principal, { run: String(visibleRun) })).toMatchObject({ session: { kind: "run", id: visibleRun } });
  });

  test("step cards carry the phone's passkey hints: protected work and release, from the project's rules", async () => {
    const plain = await reads.taskSteps(principal, { task: "t-mine" }) as { passkey: unknown };
    expect(plain.passkey).toEqual({ protectedWork: false, release: false, protectedPaths: [] });
    store.setApprovalRules(repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", T0);
    const guarded = await reads.taskSteps(principal, { task: "t-mine" }) as { passkey: unknown };
    expect(guarded.passkey).toEqual({ protectedWork: true, release: false, protectedPaths: [] });
  });

  test("work rows are the account's own view, with spend and provider limits never sent", async () => {
    const rows = await reads.workRows(principal, {}) as { spend: unknown; limits: unknown; next: unknown } & Record<string, unknown>;
    expect(rows.spend).toBeNull();
    expect(rows.limits).toBeNull();
    const text = JSON.stringify(rows);
    expect(text).toContain("t-mine");
    expect(text).not.toContain("t-hidden");
    expect(text).not.toContain(hidden);
  });

  test("standing is proved before and after a read: a phone retired while the read runs gets standing_revoked", async () => {
    const getRun = store.getRun.bind(store);
    vi.spyOn(store, "getRun").mockImplementationOnce(id => { revokePairedDeviceRecord(store.handle, "dev_bea", new Date(), "removed"); return getRun(id); });
    expect(await refusal(() => reads.runWindowRead(principal, { run: String(visibleRun) }))).toEqual({ code: "standing_revoked", message: "This iPhone is no longer paired." });
    // And before: nothing is read at all.
    expect(await refusal(() => reads.workRows(principal, {}))).toMatchObject({ code: "standing_revoked" });
    expect(await refusal(() => reads.deviceHello(principal))).toMatchObject({ code: "standing_revoked" });
  });

  test("a watch whose account loses the project mid-stream ends as denied and emits nothing more", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const emitted: Buffer[] = [];
    const ends: (string | undefined)[] = [];
    const sub = reads.runWatchSubscribe!(principal, { run: String(visibleRun) }, record => emitted.push(record), reason => ends.push(reason ?? "done"));
    expect(sub.ok).toBe(true);
    await Promise.resolve(); // the first tick (queued as a microtask) finds the run in view and still running
    expect(ends).toEqual([]);
    // The project leaves the account's list without the derived revocation (the read must catch it on its own).
    store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'bea'").run(JSON.stringify([hidden]));
    vi.advanceTimersByTime(2_000);
    expect(ends).toEqual(["denied"]);
    const after = emitted.length;
    vi.advanceTimersByTime(10_000);
    expect(emitted.length).toBe(after);
    expect(ends).toEqual(["denied"]);
  });

  test("bad parameters and cursors are refused with their own codes; hello names exactly its documented fields", async () => {
    expect(await refusal(() => reads.taskSteps(principal, {}))).toMatchObject({ code: "invalid_params" });
    expect(await refusal(() => reads.taskSteps(principal, { task: 7 }))).toMatchObject({ code: "invalid_params" });
    expect(await refusal(() => reads.runWindowRead(principal, { run: "0" }))).toMatchObject({ code: "invalid_params" });
    expect(await refusal(() => reads.workRows(principal, { view: "nonsense" }))).toMatchObject({ code: "invalid_params" });
    expect(await refusal(() => reads.workRows(principal, { cursor: "" }))).toMatchObject({ code: "invalid_cursor" });
    expect(await refusal(() => reads.workRows(principal, { cursor: "not-a-cursor" }))).toMatchObject({ code: "invalid_cursor" });
    const hello = await reads.deviceHello(principal) as Record<string, unknown>;
    expect(Object.keys(hello).sort()).toEqual(["account", "deviceId", "toolroll", "version", "workspaceId", "workspaceLabel"]);
    expect(hello).toMatchObject({ account: "bea", deviceId: "dev_bea", workspaceId: principal.workspaceId });
  });
});
