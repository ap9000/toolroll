/**
 * Easy start D: the console socket's `link` verb (`toolroll open`). The console answers `link` with a fresh challenge
 * of its own; only HMAC(secret, "link:" + challenge) — the secret is in the database, behind the agent fence — gets one
 * local owner's one-time sign-in path, minted by the real console (mintLocalLink) and only while local mode is on.
 * A wrong answer, a replayed answer, a hello proof, a second answer on one challenge and a socket without the verb are
 * each refused; the request names no account.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { askLink, claimInstance, instanceRunDir, linkProof, openInstanceSocket, readInstance, requestLocalLink, socketProof } from "./console-instance.js";
import { createDecisionServer, type DecisionServer } from "./serve.js";
import { initLocalMode, openStore, setLocalModeOff, type Store } from "./store.js";
import { shortTempDir } from "../test/short-temp.js";
import { SOCKETS_TOO_DEEP } from "../test/inside-fence.js";

const BUILD = "9.9.9-test";
const now = new Date("2026-11-04T09:00:00Z");
let dir: string, databaseFile: string, store: Store, server: DecisionServer, socketPath: string, secret: string;
const closers: (() => void | Promise<void>)[] = [];

async function startConsole(withLink = true): Promise<void> {
  let minted: string | null = null;
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: join(dir, "shop"), instanceSecret: () => minted });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const socket = await openInstanceSocket(databaseFile, { pid: process.pid, build: BUILD, database: databaseFile, port }, () => minted, withLink ? () => server.mintLocalLink() : undefined);
  if (!socket.ok) throw Error(socket.problem);
  closers.push(() => socket.close());
  minted = await claimInstance(store, databaseFile, { pid: process.pid, port, build: BUILD, socket: socket.name }, now);
  secret = minted!;
  socketPath = join(instanceRunDir(databaseFile), readInstance(store)!.socket);
}

/** One conversation on the socket: each line sent after the previous answer, every answer read back. */
function converse(lines: ((answers: Record<string, unknown>[]) => object)[]): Promise<Record<string, unknown>[]> {
  return new Promise(resolve => {
    const answers: Record<string, unknown>[] = [];
    const socket = createConnection(socketPath);
    let buffer = "", next = 0;
    const send = () => { if (next < lines.length) socket.write(`${JSON.stringify(lines[next++]!(answers))}\n`); };
    socket.setEncoding("utf8");
    socket.on("connect", send);
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        answers.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
        buffer = buffer.slice(end + 1);
        send();
      }
    });
    socket.on("close", () => resolve(answers));
    socket.on("error", () => resolve(answers));
  });
}
const challengeOf = (answers: Record<string, unknown>[]): string => String(answers[0]?.["challenge"]);

beforeEach(() => {
  dir = shortTempDir("so-link-");
  mkdirSync(join(dir, "s"), { mode: 0o700 });
  mkdirSync(join(dir, "shop"));
  databaseFile = join(dir, "s", "orders.db");
  store = openStore(databaseFile, { createdBy: "laptop" });
  if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now }).ok) throw Error("local mode");
  // A fresh database's whole schema is ~0.5 s of CPU on an idle machine; a loaded CI runner took over the 10 s default.
}, 60_000);
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(SOCKETS_TOO_DEEP)("the link verb", () => {
  test("proved console, right answer: one local owner's one-time path on the console's own address, and it signs in once", async () => {
    await startConsole();
    const got = await requestLocalLink(databaseFile, store, BUILD);
    if (!got.ok) throw Error(got.message);
    expect(got.url).toMatch(new RegExp(`^${got.console}/login/once/[A-Za-z0-9_-]+$`));
    const first = await fetch(got.url, { redirect: "manual" });
    expect(first.headers.get("set-cookie") ?? "").toMatch(/so_session|session/i);
    // Single use: the same link signs nobody in again.
    const again = await fetch(got.url, { redirect: "manual" });
    expect(again.headers.get("set-cookie") ?? "").toBe("");
  });

  test("a wrong HMAC, a hello proof, or no proof at all is refused, and the challenge is spent by it", async () => {
    await startConsole();
    const wrong = await converse([() => ({ verb: "link" }), answers => ({ verb: "link-proof", proof: linkProof("f".repeat(64), challengeOf(answers)) })]);
    expect(wrong.at(-1)).toEqual({ error: "refused" });
    const hello = await converse([() => ({ verb: "link" }), answers => ({ verb: "link-proof", proof: socketProof(secret, challengeOf(answers)) })]);
    expect(hello.at(-1)).toEqual({ error: "refused" });
    const other = await converse([() => ({ verb: "link" }), answers => ({ verb: "hello", challenge: challengeOf(answers) })]);
    expect(other.at(-1)).toEqual({ error: "refused" });
    // Two answers on one challenge: the first (wrong) one spends it and the connection ends; the right one never counts.
    const twice = await converse([() => ({ verb: "link" }), () => ({ verb: "link-proof", proof: "0".repeat(64) }), answers => ({ verb: "link-proof", proof: linkProof(secret, challengeOf(answers)) })]);
    expect(twice).toHaveLength(2);
    expect(twice[1]).toEqual({ error: "refused" });
  });

  test("a replayed answer (for another connection's challenge) is refused", async () => {
    await startConsole();
    const seen = await converse([() => ({ verb: "link" }), answers => ({ verb: "link-proof", proof: linkProof(secret, challengeOf(answers)) })]);
    expect(String(seen[1]?.["link"])).toMatch(/^\/login\/once\//);
    const replayed = await converse([() => ({ verb: "link" }), () => ({ verb: "link-proof", proof: linkProof(secret, challengeOf(seen)) })]);
    expect(replayed.at(-1)).toEqual({ error: "refused" });
  });

  test("local mode off: the right answer gets no link", async () => {
    await startConsole();
    expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true });
    expect(await askLink(socketPath, secret)).toBeNull();
    expect(await requestLocalLink(databaseFile, store, BUILD)).toMatchObject({ ok: false });
  });

  test("a console without the verb refuses it; hello still answers", async () => {
    await startConsole(false);
    expect(await converse([() => ({ verb: "link" })])).toEqual([{ error: "refused" }]);
    const hello = await converse([() => ({ verb: "hello", challenge: "a".repeat(64) })]);
    expect(hello[0]?.["proof"]).toBe(socketProof(secret, "a".repeat(64)));
  });
});
