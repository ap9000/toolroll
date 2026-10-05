import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TURN_WALL_CLOCK_MS } from "./converse.js";
import { MATE_ABORT_GRACE_MS } from "./mate.js";
import { fileTaskProposal } from "./proposal.js";
import { mateTimeoutNotice, openStore, type ChatConfig, type Store } from "./store.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";
import { createTeamRuntime } from "./team-runtime.js";
import type { TeamActor } from "./team-contract.js";

const T0 = new Date("2026-10-04T23:00:00.000Z");
const REPO = "/repo/team-stall";
const SUB: ChatConfig = { provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 };
const reply = (text: string, calls: { id: string; name: string; args: Record<string, unknown> }[] = []) =>
  ({ ok: true as const, answer: { text, calls, tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null } });

// Release check 2438: in a shared conversation the lead proposed, never finished its reply, and the next message got no answer.
describe("a shared conversation's turn that never finishes", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-team-stall-"));
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    const filed = fileTaskProposal(store, { id: "digest", title: "wire the nightly digest", repo: REPO, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("ends at its deadline with the notice and its proposal, ends its provider run, and the queued next message is answered", async () => {
    const signals: AbortSignal[] = [];
    let hung!: () => void;
    const hanging = new Promise<void>(resolve => { hung = resolve; });
    const subscriptionRunner: SubscriptionMateRunner = request => {
      signals.push(request.signal!);
      if (signals.length === 1) return Promise.resolve(reply("Holding it.", [{ id: "h1", name: "propose_hold", args: { task: "digest", reason: "not this week" } }]));
      if (signals.length === 2) { hung(); return new Promise(() => undefined); }
      return Promise.resolve(reply("Nothing else needs you."));
    };
    const runtime = createTeamRuntime({ store, repos: () => [REPO], evidenceRoot: dir, provider: () => ({ config: SUB, key: null }), subscriptionRunner, clock: () => T0, capacity: 1 });
    const actor: TeamActor = { name: "alex", generation: store.accountOf("alex")!.generation };
    const leadId = ((await runtime.execute(actor, { operation: "create-lead", args: { name: "Launch lead", projects: [REPO] } })).result as { leadId: string }).leadId;
    const created = await runtime.execute(actor, { operation: "create-conversation", args: { leadId, title: "Launch", visibility: "team", projects: [REPO] } });
    const conversationId = (created.result as { conversationId: string }).conversationId;
    const terms = created.snapshot!.chatAuthorization!;
    expect(await runtime.execute(actor, { operation: "authorize", args: { conversationId, termsDigest: terms.termsDigest } })).toMatchObject({ ok: true });
    const send = (text: string, requestId: string) => runtime.execute(actor, { operation: "send", args: { conversationId, text, requestId } });
    expect(await send("hold the nightly digest", "first")).toMatchObject({ ok: true });
    expect(await send("anything else?", "second")).toMatchObject({ ok: true });
    const statuses = () => runtime.domain.snapshot(actor, conversationId).messages.map(one => [one.role, one.status, one.error]);

    await runtime.pass();
    await hanging;
    // The second message waits behind the running one.
    await runtime.pass();
    expect(statuses()).toEqual([["operator", "running", null], ["operator", "queued", null]]);

    await vi.advanceTimersByTimeAsync(TURN_WALL_CLOCK_MS);
    expect(signals[1]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(MATE_ABORT_GRACE_MS);
    // One plain notice in the thread (none repeated on the message), and the proposal it made.
    expect(statuses()).toEqual([["operator", "failed", null], ["operator", "queued", null], ["assistant", "answered", null]]);
    const view = runtime.domain.snapshot(actor, conversationId);
    expect(view.messages[2]).toMatchObject({ text: mateTimeoutNotice(true), turnId: view.messages[0]?.turnId });
    const proposals = (await runtime.execute(actor, { operation: "send", args: { conversationId, text: "anything else?", requestId: "second" } })).snapshot?.proposals;
    expect(proposals).toMatchObject([{ state: "pending", href: expect.stringContaining("proposal=") }]);

    await runtime.pass();
    await vi.waitFor(() => expect(statuses()).toHaveLength(4));
    expect(statuses()[1]).toEqual(["operator", "answered", null]);
    expect(runtime.domain.snapshot(actor, conversationId).messages.at(-1)).toMatchObject({ role: "assistant", text: "Nothing else needs you." });
    await runtime.close();
  });
});
