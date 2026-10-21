/** The lead queue's runtime (lead-queue-runtime.ts): a wake from inside a browser request never lends that request's
 * session facts to a queued message — the pass runs in the server's own context, and the queue re-proves the person. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPersonalQueueRuntime } from "./lead-queue-runtime.js";
import { PersonalQueue } from "./lead-queue.js";
import { freshFacts, addApprover } from "./scope.js";
import { requestContext } from "./server/request-context.js";
import { verifyApproverStanding } from "./principal.js";
import { openStore, type Store } from "./store.js";

const T0 = new Date("2026-10-20T12:00:00.000Z");
let store: Store;
beforeEach(() => { store = openStore(":memory:"); });
afterEach(() => store.close());

test("a wake from inside a browser request runs the queue in the server's own context: no actor, form token or Passwordless session leaks", async () => {
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("approver");
  const standing = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, ["/repo"]);
  if (!standing.ok) throw new Error("standing");
  const who = standing.who;
  const session = store.getLeadSession(store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: "k", ceilingMicrousd: 1_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0))!;
  const thread = store.openLeadThread("alex", who.ceilingDigest, T0).thread;
  // Something of alex's runs, a message waits behind it, then the running turn ends.
  const opened = store.openLeadTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey: "k", reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, T0);
  if (!opened.ok) throw new Error(opened.reason);
  const queue = new PersonalQueue(store);
  expect(queue.sendOrQueue({ approver: "alex", approverGeneration: who.generation, session: session.id, ceilingDigest: who.ceilingDigest, thread: thread.id, text: "waiting", requestId: "a".repeat(32), context: null }, T0).kind).toBe("queued");
  store.handle.prepare("UPDATE mate_turn SET state = 'answered'").run();

  const seen: { request: unknown; fresh: unknown }[] = [];
  const runtime = createPersonalQueueRuntime({
    store, evidenceRoot: "/nowhere", clock: () => T0, everyMs: 60_000,
    // The first thing a claim's run consults: record the async context it runs in.
    admittedReposFor: account => { seen.push({ request: requestContext.getStore(), fresh: freshFacts.getStore() }); return account === "alex" ? ["/repo"] : []; },
    contextStands: () => true, provider: () => null, names: { project: path => path, modes: {} },
  });
  runtime.start();
  try {
    // A browser request of someone else's, with a form token and a Passwordless session, wakes the queue.
    requestContext.run({ csrf: "leaked-token", returnTo: "/", actor: "mallory", passwordless: true },
      () => freshFacts.run({ passwordAt: T0.toISOString() } as never, () => runtime.kick()));
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ request: undefined, fresh: undefined });
    // Chat is off here (no provider): the message waits, with its words, instead of being lost.
    expect(queue.backlog("alex")).toEqual([expect.objectContaining({ status: "queued", error: expect.stringContaining("chat is off") })]);
  } finally { await runtime.close(); }
});
