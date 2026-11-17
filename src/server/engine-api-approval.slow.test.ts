/**
 * The approval card's nonce pool (GET /t/<task>/approval): a card read again holds the nonce it minted, so a thousand
 * reads of one card never push another task's open approval form out of the shared, bounded pool. Slow: a thousand reads
 * through the real console.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";
import { openApprovalWorld, type ApprovalWorld } from "../../test/approval-card-world.js";

let world: LocalWorld, terminal: ApprovalWorld["terminal"], sentBack: ApprovalWorld["sentBack"], card: ApprovalWorld["card"];
beforeEach(async () => { ({ world, terminal, sentBack, card } = await openApprovalWorld()); }, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

test("reading one card a thousand times never pushes another task's open form out of the pool", async () => {
  const session = await terminal();
  const other = await sentBack(session);
  const revision = await sentBack(session);
  const held = await card(session, other);
  const reads = new Set<string>();
  for (let read = 0; read < 1000; read += 1) reads.add((await card(session, revision)).nonce!);
  expect(reads.size).toBe(1);
  expect((await session.act(`/t/${other}/approve`, { digest: held.digest!, nonce: held.nonce!, token: "" })).body).toMatchObject({ outcome: "approved" });
});
