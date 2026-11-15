/**
 * A terminal start the session alone proved (a solo install, install-mode.ts) keeps that proof only while the session
 * still stands in: a person who joins, or Passwordless turned off, while the worktree is being prepared refuses the
 * launch right before the program starts. Isolated store, a stand-in terminal host (nothing is spawned).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { hashPassword } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { TerminalError, type TerminalHost } from "../live-terminal.js";
import { setPasswordless } from "../passwordless.js";

const PASSWORD = "alex-password-1";
let dir: string, store: Store, server: Server, base: string;
/** What happens while the worktree is "prepared", then the console's own check right before the program would start. */
let meanwhile: () => void = () => {};
const PASSED = "admitted: the program would start here";

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-solo-term-")));
  store = openStore(":memory:");
  expect(store.bootstrapApproverIfNone("alex", hashPassword(PASSWORD), new Date())).toEqual({ ok: true });
  const host = {
    start: async (_owner: unknown, _repo: string, _program: string, _size: unknown, admit: () => string | null) => {
      await new Promise(resolve => setTimeout(resolve, 1));
      meanwhile();
      throw new TerminalError(admit() ?? PASSED);
    },
    list: () => [], get: () => undefined,
  } as unknown as TerminalHost;
  server = createDecisionServer({ store, evidenceRoot: dir, repos: [dir], terminalHost: host } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  meanwhile = () => {};
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Signed in, with the password typed at sign-in forgotten: an empty password then stands only on the mode. */
async function session(): Promise<{ cookie: string; csrf: string }> {
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: PASSWORD }), redirect: "manual" });
  const cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  const csrf = /data-csrf="([^"]+)"/.exec(await (await fetch(`${base}/term`, { headers: { cookie } })).text())![1]!;
  const forgot = await fetch(`${base}/session/forget-password`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, return: "/term" }), redirect: "manual" });
  expect(forgot.status).toBe(303);
  return { cookie, csrf };
}
const startTerminal = async (who: { cookie: string; csrf: string }) => {
  const answer = await fetch(`${base}/term/start`, { method: "POST", headers: { cookie: who.cookie, origin: base, accept: "application/json" },
    body: new URLSearchParams({ csrf: who.csrf, repo: dir, program: "shell", password: "" }), redirect: "manual" });
  return { status: answer.status, body: await answer.json() as { ok: boolean; error?: string } };
};

test("solo: the session starts a terminal with no password typed", async () => {
  expect(await startTerminal(await session())).toEqual({ status: 409, body: { ok: false, error: PASSED } });
});

test("a person joins while the terminal is prepared: the launch refuses", async () => {
  const who = await session();
  meanwhile = () => store.saveApprover("robin", hashPassword("robin-password-1"), new Date());
  expect((await startTerminal(who)).body.error).toMatch(/sign-in rules changed/);
});

test("Passwordless turned off while the terminal is prepared: the launch refuses", async () => {
  const who = await session();
  meanwhile = () => { setPasswordless(store, false, "alex", new Date()); };
  expect((await startTerminal(who)).body.error).toMatch(/sign-in rules changed/);
});
