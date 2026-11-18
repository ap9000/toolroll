/**
 * Starting a Flexible thread over HTTP (pre-enable), with the switch mocked on (tests only, vi.mock; the build's is
 * false and flexible-disabled.test.ts proves the road refuses then): a person's yes to exact terms. Without a key the
 * road answers the terms card and makes nothing; the start names the card's key, which is made again at the moment of
 * use (a project, network or terms that moved in between is a stale key, refused); the yes is proved as an approval's
 * is (a team install: a password typed now; a laptop install: the local owner's own act); and the thread starts under
 * exactly the card's terms digest, model and network. The thread start itself is a recording stand-in here (the engine's
 * own start is flexible-session.test.ts and flexible-launcher.test.ts): no agent process, no model.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "../flexible.js";
import { linkRedemptionSchema } from "../contracts/engine-api.js";
import { threadWorld, type ThreadWorld } from "../../test/flexible-thread-world.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";
import { removeStandInSignIn, standInSignIn } from "../../test/flexible-sign-in-kit.js";
import type { Store } from "../store.js";

vi.mock("../flexible-available.js", async original => ({ ...await original<typeof import("../flexible-available.js")>(), flexibleAvailable: () => true }));
const held = vi.hoisted(() => ({ starts: [] as Record<string, unknown>[] }));
vi.mock("../flexible-session.js", async importOriginal => {
  const real = await importOriginal<typeof import("../flexible-session.js")>();
  return { ...real, startFlexibleThread: async (_store: unknown, _sessions: unknown, input: Record<string, unknown>) => {
    held.starts.push(input);
    return { ok: true, thread: "e".repeat(32), turn: "f".repeat(32) };
  } };
});

/** `person`'s own Claude sign-in for threads (a stand-in, never a real one). */
function signIn(store: Store, state: string, person: string): void { standInSignIn(store, state, person); }

type Card = { outcome: string; key: string; terms: { label: string; words: string; lines: string[] }[]; notes: string[]; lines: string[] };

function plant(store: ThreadWorld["store"] | LocalWorld["store"], repo: string, signer: string): string {
  const terms: FlexibleTerms = { version: 1, repo, signer, signerGeneration: store.accountOf(signer)!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: store.projectNetwork(repo).mode === "open" ? "open" : "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  const digest = flexibleDigestOf(terms), at = new Date().toISOString();
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'password-now', ?, ?)`).run(repo, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, signer, at, signer, at);
  return digest;
}

describe("a team install: the card, a stale key, and a password typed now", () => {
  let world: ThreadWorld, server: Server, base: string, cookie: string, csrf: string, patToken: string, digest: string;
  beforeAll(async () => {
    world = threadWorld();
    const alex = addApprover(world.store, "alex", new Date());
    if (!alex.ok) throw new Error("alex");
    const pat = addApprover(world.store, "pat", new Date(), { name: "alex", token: alex.token });
    if (!pat.ok) throw new Error("pat");
    patToken = pat.token;
    expect(world.store.setAccountProjects("pat", [world.project], "alex", new Date())).toEqual({ ok: true });
    digest = plant(world.store, world.project, "alex");
    signIn(world.store, world.state, "pat");
    server = createDecisionServer({ store: world.store, evidenceRoot: join(world.dir, "evidence"), repos: [world.project], clock: () => new Date() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "pat", token: patToken }), redirect: "manual" });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${base}/settings/project?repo=${encodeURIComponent(world.project)}`, { headers: { cookie } })).text();
    csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
  }, 60_000);
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    world.store.close();
    rmSync(world.dir, { recursive: true, force: true });
  });
  const start = async (fields: Record<string, string>) => {
    const response = await fetch(`${base}/agents/live/thread`, { method: "POST", redirect: "manual",
      headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
      body: new URLSearchParams({ csrf, repo: world.project, message: "Fix the README", ...fields }).toString() });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  test("asked without a key: the whole card, nothing made; named with it: the start runs under exactly the card's terms", async () => {
    held.starts.length = 0;
    const asked = await start({});
    expect(asked.status).toBe(200);
    const card = asked.body as unknown as Card;
    expect(card.outcome).toBe("thread-terms");
    expect(card.key).toMatch(/^[0-9a-f]{32}$/);
    expect(card.terms.map(row => row.label)).toEqual(["Project", "Level", "Agent", "Works in", "Network", "Limits", "Ship", "Terms"]);
    expect(card.terms.find(row => row.label === "Level")?.words).toBe("Full access: no permission prompts inside the sandbox");
    expect(card.terms.find(row => row.label === "Agent")?.words).toBe("Claude Sonnet 5.5, signed in through Toolroll's relay");
    expect(card.lines.join("\n")).toContain("merges only when the project's required check passes on that exact commit");
    expect(card.notes.join(" ")).toContain("whole history");
    expect(held.starts).toEqual([]);
    // The same request gives the same card (the key is deterministic).
    expect(((await start({})).body as unknown as Card).key).toBe(card.key);
    // A team install: the yes needs a password typed now.
    expect(await start({ terms: card.key })).toEqual({ status: 403, body: { outcome: "refused", words: "Starting a thread needs your password here. Nothing was started." } });
    expect(held.starts).toEqual([]);
    const done = await start({ terms: card.key, password: patToken });
    expect(done).toEqual({ status: 200, body: { outcome: "done", words: "The thread started." } });
    expect(held.starts).toHaveLength(1);
    expect(held.starts[0]).toMatchObject({ repo: world.project, digest, model: "claude-sonnet-5-5", message: "Fix the README", freshProof: true, expectNetwork: expect.stringMatching(/^[0-9a-f]{32}$/),
      billing: "subscription", startKey: card.key });
    expect(held.starts[0]!["launcher"]).not.toBeNull();
    expect((held.starts[0]!["by"] as { name: string }).name).toBe("pat");
  });

  test("a key from before a change is stale and refused, whatever moved: the network, the model, the message", async () => {
    held.starts.length = 0;
    const card = (await start({})).body as unknown as Card;
    const other = (await start({ model: "claude-opus-5-5" })).body as unknown as Card;
    expect(other.key).not.toBe(card.key);
    expect((await start({ terms: card.key, password: patToken, model: "claude-opus-5-5" })).status).toBe(409);
    expect((await start({ terms: card.key, password: patToken, message: "Something else" })).status).toBe(409);
    world.store.setProjectNetwork(world.project, { mode: "allowlist", hosts: ["api.example.com"], loopback: "proxy-only" }, "alex", new Date());
    const stale = await start({ terms: card.key, password: patToken });
    expect(stale).toEqual({ status: 409, body: { outcome: "refused", words: "The terms changed since they were shown. Read them again before starting. Nothing was started." } });
    expect(held.starts).toEqual([]);
    // The card as it stands now names the new host, under a new key.
    const now = (await start({})).body as unknown as Card;
    expect(now.key).not.toBe(card.key);
    expect(now.terms.find(row => row.label === "Network")?.words).toContain("api.example.com");
    // A model the relay doesn't forward builds no card.
    expect((await start({ model: "gpt-5" })).status).toBe(409);
  });

  test("what's still missing is named, in order (your own sign-in before the project's terms), so the terminal can open it; the card says whose plan it is", async () => {
    held.starts.length = 0;
    const card = (await start({})).body as unknown as Card;
    expect(card.terms.find(row => row.label === "Agent")?.lines.join(" ")).toMatch(/Your Claude plan \(the sign-in you saved on \d{4}-\d{2}-\d{2}\)\. It powers only threads you start\./);
    // No sign-in, and no terms either: the sign-in is named first.
    removeStandInSignIn(world.store, "pat");
    world.store.handle.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = 'alex', end_reason = 'replaced' WHERE ended_at IS NULL").run(new Date().toISOString());
    const noSignIn = await start({});
    expect(noSignIn).toMatchObject({ status: 409, body: { outcome: "refused", next: "sign-in" } });
    expect(String(noSignIn.body["words"])).toContain("claude setup-token");
    // Signed in again: the project's terms are next.
    const again = standInSignIn(world.store, world.state, "pat");
    expect(await start({})).toMatchObject({ status: 409, body: { outcome: "refused", next: "project-terms" } });
    digest = plant(world.store, world.project, "alex");
    // Claude refused that sign-in on a call: named as such, before anything else.
    world.store.handle.prepare(`INSERT INTO thread_relay_call (thread, turn, launch, upstream, at, ended_at, route, streamed, status, http_status, cost_basis, sign_in_person, sign_in_generation, sign_in_refused)
      VALUES (?, ?, ?, 'claude', 't', 't', 'messages', 0, 'upstream-error', 401, 'estimated', 'pat', ?, 1)`).run("a".repeat(32), "b".repeat(32), "c".repeat(32), again.generation);
    expect(await start({})).toMatchObject({ status: 409, body: { outcome: "refused", next: "sign-in-refused" } });
    standInSignIn(world.store, world.state, "pat");
    expect((await start({})).body["outcome"]).toBe("thread-terms");
    expect(held.starts).toEqual([]);
  });
});

describe("a laptop install: the local owner's own act at this computer", () => {
  let world: LocalWorld;
  beforeAll(async () => { world = await openLocalWorld({ browserKey: true }); world.store.upsertProject(world.repo, "shop", new Date()); plant(world.store, world.repo, "alex"); signIn(world.store, world.configDir, "alex"); }, LOCAL_WORLD_SETUP_MS);
  afterAll(async () => { await world.close(); });

  test("the terminal's session reads the card and starts the thread with no password, as the owner's act", async () => {
    held.starts.length = 0;
    const link = world.server.mintLocalLink()!;
    const redeemed = await world.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
    const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
    const cookie = `${body.cookie.name}=${body.cookie.value}`;
    const post = (fields: Record<string, string>) => world.send("/agents/live/thread", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": body.key,
      "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" }, new URLSearchParams({ csrf: body.csrf, repo: world.repo, message: "Tidy the README", ...fields }).toString());
    const asked = await post({});
    expect(asked.status).toBe(200);
    const card = JSON.parse(asked.body) as Card;
    expect(card.outcome).toBe("thread-terms");
    expect(held.starts).toEqual([]);
    const started = await post({ terms: card.key });
    expect(JSON.parse(started.body)).toEqual({ outcome: "done", words: "The thread started." });
    expect(held.starts).toHaveLength(1);
    expect(held.starts[0]).toMatchObject({ repo: world.repo, freshProof: true, by: { name: "alex" }, billing: "subscription" });
    // A stale key is refused for the owner too.
    expect(JSON.parse((await post({ terms: "0".repeat(32) })).body)).toMatchObject({ outcome: "refused" });
    expect(held.starts).toHaveLength(1);
  });
});
