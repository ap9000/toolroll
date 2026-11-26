/**
 * A laptop install with Ready results (test/local-owner-world.ts, local-owner-results.ts) for the workbench's approval of a
 * sent-back revision: the terminal client's session as the workbench redeems it, a result sent back on its own road with
 * the revision planned (the terms kept), and the approval card read with the terminal's key. Shared by
 * src/server/engine-api-approval.test.ts and its .slow sibling.
 */
import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openLocalWorld } from "./local-owner-world.js";
import { resultFixtures } from "./local-owner-results.js";
import { plannerKeptTerms } from "./serve-kit.js";
import { approvalCardSchema, linkRedemptionSchema, stepCardsSchema } from "../src/contracts/engine-api.js";

export type ApprovalWorld = Awaited<ReturnType<typeof openApprovalWorld>>;

export async function openApprovalWorld() {
  const world = await openLocalWorld({ browserKey: true });
  const fx = resultFixtures(world, join(world.root, "evidence"));
  fx.prepare();
  /** The local owner's terminal session, as the workbench redeems it (POST /login/once). */
  async function terminal() {
    const link = world.server.mintLocalLink()!;
    const redeemed = await world.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
    const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
    const cookie = `${body.cookie.name}=${body.cookie.value}`;
    const get = async (path: string, headers: Record<string, string> = { cookie }) => {
      const answer = await world.send(path, "GET", { accept: "application/json", ...headers });
      return { status: answer.status, body: answer.body };
    };
    // An act as the workbench posts it (client.rs act): form token, mutation key, its answer asked for in place.
    const act = async (path: string, fields: Record<string, string>) => {
      const answer = await world.send(path, "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", accept: "application/json",
        "x-toolroll-key": body.key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" }, new URLSearchParams({ csrf: body.csrf, ...fields }).toString());
      return { status: answer.status, body: JSON.parse(answer.body) as { outcome: string; words: string } };
    };
    // The approval card's read, with exactly the headers the workbench's own client sends on it (read from its source).
    const keyed = workbenchApprovalReadHeaders({ cookie, key: body.key });
    return { cookie, key: body.key, get, keyed, act };
  }

  /** A Ready result sent back from the workbench (its own road), and the revision planned with the terms kept. */
  /** `context`: what a page fills in ahead of the person's note (a quoted requirement), sent as the form's own field. */
  async function sentBack(session: Awaited<ReturnType<typeof terminal>>, note = "Round the tax to cents.", context?: string): Promise<string> {
    const result = fx.ready("ordinary");
    const steps = stepCardsSchema.parse(JSON.parse((await session.get(`/t/${result.id}/steps`)).body));
    expect(steps.review?.run).toBe(result.runId);
    const sent = await session.act(`/r/${result.runId}/comment`, { intent: "revise", note, ...(context === undefined ? {} : { context }), request: randomBytes(16).toString("hex"), batch: "", source: steps.review!.source });
    expect(sent.body).toEqual({ outcome: "done", words: "Sent back. The revision is filed." });
    const revision = world.store.handle.prepare("SELECT consumed_by AS id FROM diff_comment WHERE run = ?").get(result.runId)?.["id"] as string;
    plannerKeptTerms(world.store, revision);
    return revision;
  }

  const card = async (session: Awaited<ReturnType<typeof terminal>>, task: string) => {
    const answer = await session.get(`/t/${encodeURIComponent(task)}/approval`, session.keyed);
    expect(answer.status).toBe(200);
    return approvalCardSchema.parse(JSON.parse(answer.body));
  };
  return { world, fx, terminal, sentBack, card };
}

/**
 * The headers the workbench's client (tui/crates/toolroll-api/src/client.rs) sends when it reads the approval card,
 * read from its source rather than restated here: the cookie and `accept` every read carries, and the session's key
 * only if `approval` reads through `get_keyed` and `read` adds the key for a keyed read. A client that stops sending
 * its key on this read makes every test using this fail against the real console (round 9's "Couldn't read the
 * approval (key)").
 */
export function workbenchApprovalReadHeaders(creds: { cookie: string; key: string }): Record<string, string> {
  const source = readFileSync(new URL("../tui/crates/toolroll-api/src/client.rs", import.meta.url), "utf8");
  const approval = /pub async fn approval\([\s\S]*?\n {4}\}/.exec(source)?.[0] ?? "";
  const read = /async fn read<[\s\S]*?\.send\(\)/.exec(source)?.[0] ?? "";
  expect(approval, "client.rs approval").toContain("/approval");
  expect(read).toContain('.header("cookie", creds.cookie.as_str())');
  expect(read).toContain('.header("accept", "application/json")');
  const keyedRead = /self\.get_keyed::</.test(approval);
  const keySent = /if keyed \{\s*req = req\.header\("x-toolroll-key", creds\.key\.as_str\(\)\);/.test(read);
  return { cookie: creds.cookie, accept: "application/json", ...(keyedRead && keySent ? { "x-toolroll-key": creds.key } : {}) };
}
