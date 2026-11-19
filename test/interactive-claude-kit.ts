import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
// @ts-expect-error fixture ESM without declarations
import { runInteractiveClaude } from "./fixtures/interactive-claude.mjs";
// @ts-expect-error isolation ESM without declarations
import { isolatedEnvironment } from "../scripts/isolated-env.mjs";
// @ts-expect-error journey ESM without declarations
import { checkedEnv, ownRoot } from "../scripts/e2e-kit.mjs";

export interface FixtureSignal { seq: number; event: string; [key: string]: unknown }

/** Injected streams only: never a socket, native PTY or model process. Signals are the synchronization protocol. */
export function interactiveClaudeKit(output?: Writable) {
  const input = new PassThrough({ highWaterMark: 1 }), controls = new PassThrough();
  const bytes: Buffer[] = [], events: FixtureSignal[] = [];
  const waiters = new Set<{ match: (event: FixtureSignal) => boolean; resolve: (event: FixtureSignal) => void; reject: (error: Error) => void }>();
  const screen = output ?? new Writable({ write(chunk, _encoding, callback) { bytes.push(Buffer.from(chunk)); callback(); } });
  const signals = new Writable({ write(chunk, _encoding, callback) {
    const event = JSON.parse(chunk.toString()) as FixtureSignal;
    events.push(event);
    for (const waiter of waiters) if (waiter.match(event)) { waiters.delete(waiter); waiter.resolve(event); }
    callback();
  } });
  const done: Promise<number> = runInteractiveClaude({ input, output: screen, controls, signals });
  let failure: Error | null = null;
  void done.then(() => {
    failure = new Error("Fixture ended before expected signal");
    for (const waiter of waiters) waiter.reject(failure);
    waiters.clear();
  }, (error: Error) => {
    failure = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  });
  return {
    input, controls, done, events,
    text: () => Buffer.concat(bytes).toString("utf8"),
    control: (frame: Record<string, unknown>) => controls.write(`${JSON.stringify(frame)}\n`),
    wait: (match: (event: FixtureSignal) => boolean): Promise<FixtureSignal> => {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiters.add({ match, resolve, reject }));
    },
  };
}

/** Future PTY/pipe journeys must start this exact fixture, in their own isolated world. No PATH lookup for claude.
 * fd3 accepts JSONL controls and fd4 emits sync signals; stdin/stdout carry terminal bytes only.
 */
export function spawnInteractiveClaude(root: string) {
  const world = isolatedEnvironment({ root, outer: {}, set: { TERM: "xterm-256color" } });
  ownRoot(root);
  return spawn(process.execPath, [fileURLToPath(new URL("./fixtures/interactive-claude.mjs", import.meta.url)), "--fixture-interactive"], {
    cwd: root,
    env: checkedEnv(world.env),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
}
